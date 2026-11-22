use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use anchor_spl::memo::Memo;
use anchor_spl::token_2022::Token2022;
use raydium_clmm_cpi::{cpi, states::PoolState};
use crate::{VaultError, VaultState};

macro_rules! vault_signer {
    ($signer:ident, $vault:expr) => {
        let mint = $vault.token_mint;
        let bump = [$vault.bump];
        let seeds: &[&[u8]] = &[b"vault", mint.as_ref(), &bump];
        let $signer: &[&[&[u8]]] = &[seeds];
    };
}

/// Проверяем, что пул — это именно пара TOKEN_A / TOKEN_B нашего vault.
fn check_pool(vault: &VaultState, pool: &PoolState) -> Result<()> {
    require!(vault.token_mint_b != Pubkey::default(), VaultError::PairNotSet);
    let pair_ok = (pool.token_mint_0 == vault.token_mint && pool.token_mint_1 == vault.token_mint_b)
        || (pool.token_mint_0 == vault.token_mint_b && pool.token_mint_1 == vault.token_mint);
    require!(pair_ok, VaultError::WrongPool);
    Ok(())
}

#[derive(Accounts)]
pub struct AddPairToken<'info> {
    #[account(
        mut,
        has_one = admin @ VaultError::Unauthorized,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Второй токен пары (TOKEN_B)
    pub token_mint_b: Account<'info, Mint>,

    /// Токен-аккаунт vault для TOKEN_B — seeds: ["vault_tokens_b", token_mint]
    #[account(
        init,
        payer = admin,
        token::mint = token_mint_b,
        token::authority = vault_state,
        seeds = [b"vault_tokens_b", vault_state.token_mint.as_ref()],
        bump,
    )]
    pub vault_token_account_b: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn add_pair_token(ctx: Context<AddPairToken>) -> Result<()> {
    let vault = &mut ctx.accounts.vault_state;
    require!(
        ctx.accounts.token_mint_b.key() != vault.token_mint,
        VaultError::SameToken
    );
    vault.token_mint_b = ctx.accounts.token_mint_b.key();
    vault.vault_token_account_b = ctx.accounts.vault_token_account_b.key();

    msg!("Pair token added: {}", vault.token_mint_b);
    Ok(())
}

#[derive(Accounts)]
pub struct VaultSwap<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ VaultError::Unauthorized,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Токены vault: TOKEN_A
    #[account(mut, address = vault_state.vault_token_account)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    /// Токены vault: TOKEN_B
    #[account(mut, address = vault_state.vault_token_account_b @ VaultError::PairNotSet)]
    pub vault_token_account_b: Box<Account<'info, TokenAccount>>,

    // ─── Raydium CLMM ───────────────────────────────────────────────────────
    /// CHECK: Raydium сам проверяет, что это amm_config пула
    pub amm_config: UncheckedAccount<'info>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    /// CHECK: хранилище пула для входного токена, сверяем с pool_state в обработчике
    #[account(mut)]
    pub input_vault: UncheckedAccount<'info>,

    /// CHECK: хранилище пула для выходного токена, сверяем с pool_state в обработчике
    #[account(mut)]
    pub output_vault: UncheckedAccount<'info>,

    /// CHECK: Raydium проверяет, что это observation пула
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    /// CHECK: mint входного токена, Raydium сверяет с input_vault
    pub input_vault_mint: UncheckedAccount<'info>,

    /// CHECK: mint выходного токена, Raydium сверяет с output_vault
    pub output_vault_mint: UncheckedAccount<'info>,

    /// CHECK: адрес программы Raydium CLMM
    #[account(address = raydium_clmm_cpi::id())]
    pub clmm_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    pub memo_program: Program<'info, Memo>,
    // remaining_accounts: tick_array_bitmap_extension + tick arrays по пути обмена
}

/// Обменять `amount_in` токенов vault через пул.
/// `a_to_b = true`: TOKEN_A → TOKEN_B, иначе TOKEN_B → TOKEN_A.
/// `amount_in = u64::MAX` — обменять весь баланс входного токена (сколько есть на момент выполнения).
/// Если получится меньше `min_amount_out` — Raydium откатит транзакцию.
pub fn swap<'a, 'b, 'c: 'info, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, VaultSwap<'info>>,
    amount_in: u64,
    min_amount_out: u64,
    a_to_b: bool,
) -> Result<()> {
    // «Весь баланс» считаем на цепочке, а не на клиенте: если кто-то докинет TOKEN_B
    // перед нашей транзакцией, swap(B→A, MAX) + sync_vault всё равно обнулит B
    let amount_in = if amount_in == u64::MAX {
        if a_to_b {
            ctx.accounts.vault_token_account.amount
        } else {
            ctx.accounts.vault_token_account_b.amount
        }
    } else {
        amount_in
    };
    require!(amount_in > 0, VaultError::ZeroAmount);

    let vault = &ctx.accounts.vault_state;
    let (input_mint, output_mint) = if a_to_b {
        (vault.token_mint, vault.token_mint_b)
    } else {
        (vault.token_mint_b, vault.token_mint)
    };

    // Хранилища пула должны соответствовать направлению обмена
    {
        let pool = ctx.accounts.pool_state.load()?;
        check_pool(vault, &pool)?;
        let pool_vault_of = |mint: Pubkey| {
            if mint == pool.token_mint_0 {
                pool.token_vault_0
            } else {
                pool.token_vault_1
            }
        };
        require_keys_eq!(ctx.accounts.input_vault.key(), pool_vault_of(input_mint), VaultError::WrongPool);
        require_keys_eq!(ctx.accounts.output_vault.key(), pool_vault_of(output_mint), VaultError::WrongPool);
    }

    let (input_account, output_account) = if a_to_b {
        (ctx.accounts.vault_token_account.to_account_info(), ctx.accounts.vault_token_account_b.to_account_info())
    } else {
        (ctx.accounts.vault_token_account_b.to_account_info(), ctx.accounts.vault_token_account.to_account_info())
    };

    // CPI: Raydium swap_v2. Платит и подписывает vault PDA — он владелец входных токенов.
    let cpi_accounts = cpi::accounts::SwapSingleV2 {
        payer: ctx.accounts.vault_state.to_account_info(),
        amm_config: ctx.accounts.amm_config.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        input_token_account: input_account,
        output_token_account: output_account,
        input_vault: ctx.accounts.input_vault.to_account_info(),
        output_vault: ctx.accounts.output_vault.to_account_info(),
        observation_state: ctx.accounts.observation_state.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
        memo_program: ctx.accounts.memo_program.to_account_info(),
        input_vault_mint: ctx.accounts.input_vault_mint.to_account_info(),
        output_vault_mint: ctx.accounts.output_vault_mint.to_account_info(),
    };
    vault_signer!(signer, ctx.accounts.vault_state);
    let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.clmm_program.to_account_info(), cpi_accounts, signer)
        .with_remaining_accounts(ctx.remaining_accounts.to_vec());

    cpi::swap_v2(cpi_ctx, amount_in, min_amount_out, 0, true)?;

    // Деньги vault теперь не только в TOKEN_A → deposit/withdraw на паузе до sync_vault
    ctx.accounts.vault_state.in_market = true;

    msg!("Swap: {} in (a_to_b={}), min_out={}", amount_in, a_to_b, min_amount_out);
    Ok(())
}

#[derive(Accounts)]
pub struct SyncVault<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ VaultError::Unauthorized,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(address = vault_state.vault_token_account)]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(address = vault_state.vault_token_account_b @ VaultError::PairNotSet)]
    pub vault_token_account_b: Account<'info, TokenAccount>,
}

/// Вернуть vault в обычный режим. Можно, только если всё снова в TOKEN_A:
/// TOKEN_B = 0 и позиции нет. `total_tokens` берётся из реального баланса,
/// поэтому прибыль (комиссии) или убыток (проскальзывание) делится на все shares.
pub fn sync_vault(ctx: Context<SyncVault>) -> Result<()> {
    let vault = &mut ctx.accounts.vault_state;
    require!(vault.position_nft_mint == Pubkey::default(), VaultError::PositionOpen);
    require!(ctx.accounts.vault_token_account_b.amount == 0, VaultError::TokenBNotZero);

    let before = vault.total_tokens;
    vault.total_tokens = ctx.accounts.vault_token_account.amount;
    vault.in_market = false;

    msg!("Vault synced: total_tokens {} -> {}", before, vault.total_tokens);
    Ok(())
}
