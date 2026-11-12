import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import {
  DEV_API_URLS,
  DEVNET_PROGRAM_ID,
  PoolInfoLayout,
  PoolUtils,
  PositionInfoLayout,
  Raydium,
  SqrtPriceMath,
  TickUtils,
  TxVersion,
  getPdaPersonalPositionAddress,
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import Decimal from "decimal.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
const POOL_FILE = path.join(ROOT, "devnet-pool.json");
const README_FILE = path.join(ROOT, "README.md");
const STATE_DIR = path.join(ROOT, ".anchor", "week11-position");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const BASE_AMOUNT = "100";
const SLIPPAGE = 0.01;
const START = "<!-- week11-position:start -->";
const END = "<!-- week11-position:end -->";
const REASON =
  "Ағымдағы бағадан шамамен 10% төмен және 10% жоғары аралықты таңдадым. " +
  "Бұл бағаға екі жаққа қозғалу мүмкіндігін береді және өтімділікті нақты аралыққа шоғырландырады. " +
  "Шекаралар пулдың тик қадамына сәйкестендірілді.";

interface PositionAddresses {
  nftMint: string;
  personalPosition: string;
  protocolPosition: string;
  tickArrayLower: string;
  tickArrayUpper: string;
  positionNftAccount: string;
}

interface PositionResult extends PositionAddresses {
  owner: string;
  referencePrice: string;
  tickLower: number;
  tickUpper: number;
  priceLower: string;
  priceUpper: string;
  liquidity: string;
  tx: string;
}

interface SavedPool {
  cluster: string;
  clmmProgram: string;
  tokenA: string;
  tokenB: string;
  poolId: string;
  ammConfig: string;
  tx: string;
  currentPrice?: string;
  poolAccounts?: Record<string, string>;
  position?: PositionResult;
}

interface PositionPlan {
  poolId: string;
  owner: string;
  secretKey: number[];
  referencePrice: string;
  tickLower: number;
  tickUpper: number;
  addresses?: PositionAddresses;
}

function writeAtomic(file: string, contents: string, mode: number): void {
  const temporary = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, contents, { mode });
  fs.renameSync(temporary, file);
}

function explorer(address: string): string {
  return "https://explorer.solana.com/address/" + address + "?cluster=devnet";
}

async function main(): Promise<void> {
  const simulateOnly = process.argv.includes("--simulate");
  const saved: SavedPool = JSON.parse(fs.readFileSync(POOL_FILE, "utf8"));
  const connection = new Connection(
    process.env.DEVNET_RPC || "https://api.devnet.solana.com",
    "confirmed"
  );
  if (saved.cluster !== "devnet" || (await connection.getGenesisHash()) !== DEVNET_GENESIS) {
    throw new Error("Бұл скрипт Solana devnet желісіне арналған.");
  }

  const program = DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID;
  const poolId = new PublicKey(saved.poolId);
  const initialAccount = await connection.getAccountInfo(poolId);
  if (!initialAccount || !initialAccount.owner.equals(program) || saved.clmmProgram !== program.toBase58()) {
    throw new Error("Көрсетілген аккаунт Raydium devnet CLMM пулы емес.");
  }
  const initialState = PoolInfoLayout.decode(initialAccount.data);
  if ([initialState.mintA.toBase58(), initialState.mintB.toBase58()].sort().join(",") !==
      [saved.tokenA, saved.tokenB].sort().join(",")) {
    throw new Error("Пул токендері devnet-pool.json деректерімен сәйкес келмейді.");
  }

  let wallet: Keypair | undefined;
  if (!simulateOnly) {
    const walletFile = process.env.ANCHOR_WALLET ||
      path.join(os.homedir(), ".config", "solana", "id.json");
    wallet = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(walletFile, "utf8")))
    );
  }
  const owner = wallet ? wallet.publicKey : initialState.creator;
  console.log("Әмиян —", owner.toBase58());
  console.log("Пул —", saved.poolId);

  const raydium = await Raydium.load({
    owner: wallet || owner,
    connection,
    cluster: "devnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: "finalized",
    urlConfigs: DEV_API_URLS,
  });
  const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(saved.poolId);

  async function openingTransaction(position: PublicKey): Promise<string> {
    const signatures = await connection.getSignaturesForAddress(position, { limit: 20 }, "confirmed");
    for (const entry of signatures) {
      if (entry.err) continue;
      const transaction = await connection.getParsedTransaction(entry.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (transaction && transaction.meta && !transaction.meta.err &&
          transaction.meta.logMessages &&
          transaction.meta.logMessages.some(line => line.includes("Instruction: OpenPosition"))) {
        return entry.signature;
      }
    }
    throw new Error("Позицияның ашылу транзакциясы әзірге табылмады. Скриптті қайта іске қос.");
  }

  async function saveResult(
    addresses: PositionAddresses,
    referencePrice: string,
    knownTransaction?: string
  ): Promise<void> {
    const nftMint = new PublicKey(addresses.nftMint);
    const positionId = getPdaPersonalPositionAddress(program, nftMint).publicKey;
    if (positionId.toBase58() !== addresses.personalPosition) {
      throw new Error("Позиция адресі NFT mint адресімен сәйкес келмейді.");
    }
    const nftAccountId = new PublicKey(addresses.positionNftAccount);
    const [positionAccount, poolAccount, nftAccountInfo] =
      await connection.getMultipleAccountsInfo([positionId, poolId, nftAccountId]);
    if (!positionAccount || !positionAccount.owner.equals(program) ||
        !poolAccount || !poolAccount.owner.equals(program)) {
      throw new Error("Позиция немесе пул аккаунты желіден табылмады.");
    }
    const position = PositionInfoLayout.decode(positionAccount.data);
    const pool = PoolInfoLayout.decode(poolAccount.data);
    const nftAccount = unpackAccount(nftAccountId, nftAccountInfo, TOKEN_2022_PROGRAM_ID);
    if (!position.poolId.equals(poolId) || !position.nftMint.equals(nftMint) ||
        position.liquidity.isZero() || !nftAccount.owner.equals(owner) ||
        nftAccount.mint.toBase58() !== addresses.nftMint || nftAccount.amount.toString() !== "1") {
      throw new Error("Позицияның пулы, өтімділігі немесе NFT иесі сәйкес келмейді.");
    }

    const priceLower = TickUtils.getTickPrice({ poolInfo, tick: position.tickLower, baseIn: true }).price;
    const priceUpper = TickUtils.getTickPrice({ poolInfo, tick: position.tickUpper, baseIn: true }).price;
    const currentPrice = SqrtPriceMath.sqrtPriceX64ToPrice(
      pool.sqrtPriceX64, pool.mintDecimalsA, pool.mintDecimalsB
    );
    const tx = knownTransaction || await openingTransaction(positionId);
    const result: PositionResult = {
      ...addresses,
      owner: owner.toBase58(),
      referencePrice,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      priceLower: priceLower.toFixed(12),
      priceUpper: priceUpper.toFixed(12),
      liquidity: position.liquidity.toString(),
      tx,
    };
    const poolAccounts = {
      mintA: pool.mintA.toBase58(),
      mintB: pool.mintB.toBase58(),
      vaultA: pool.vaultA.toBase58(),
      vaultB: pool.vaultB.toBase58(),
      observationId: pool.observationId.toBase58(),
      ammConfig: pool.ammConfig.toBase58(),
    };

    console.log("Позиция —", explorer(result.personalPosition));
    console.log("Позиция NFT —", explorer(result.nftMint));
    console.log("Нақты диапазон —", result.priceLower, "—", result.priceUpper);
    console.log("Позиция өтімділігі —", result.liquidity);
    console.log("Ағымдағы баға —", currentPrice.toFixed(12));
    console.log("Транзакция — https://explorer.solana.com/tx/" + tx + "?cluster=devnet");
    if (simulateOnly) return;

    const updated: SavedPool = {
      ...saved, currentPrice: currentPrice.toFixed(12), poolAccounts, position: result,
    };
    writeAtomic(POOL_FILE, JSON.stringify(updated, null, 2) + "\n", 0o644);

    const section = [
      START,
      "### 11-аптадағы өтімділік позициясы",
      "",
      "Бар CLMM пулында өз әмиянымнан бір өтімділік позициясын аштым.",
      "Негізгі токеннен " + BASE_AMOUNT + " бірлік енгізу параметрі және екінші токенге 1% slippage шегі қолданылды.",
      "Баға Raydium пулындағы бір mintA токеніне шаққандағы mintB мөлшерімен көрсетілген.",
      "",
      "- Пулдың mintA токені — \x60" + poolAccounts.mintA + "\x60",
      "- Пулдың mintB токені — \x60" + poolAccounts.mintB + "\x60",
      "- Тексеру кезіндегі баға — " + updated.currentPrice,
      "- Диапазон — " + result.priceLower + " — " + result.priceUpper,
      "- Тиктер — " + result.tickLower + " — " + result.tickUpper,
      "- Позиция өтімділігі — \x60" + result.liquidity + "\x60",
      "- [Позиция аккаунты](" + explorer(result.personalPosition) + ")",
      "- [Позиция NFT mint](" + explorer(result.nftMint) + ")",
      "- [NFT токен аккаунты](" + explorer(result.positionNftAccount) + ")",
      "- [Protocol position](" + explorer(result.protocolPosition) + ")",
      "- [Төменгі tick array](" + explorer(result.tickArrayLower) + ")",
      "- [Жоғарғы tick array](" + explorer(result.tickArrayUpper) + ")",
      "- [Пулдың vaultA аккаунты](" + explorer(poolAccounts.vaultA) + ")",
      "- [Пулдың vaultB аккаунты](" + explorer(poolAccounts.vaultB) + ")",
      "- [Observation аккаунты](" + explorer(poolAccounts.observationId) + ")",
      "- [Позиция ашу транзакциясы](https://explorer.solana.com/tx/" + tx + "?cluster=devnet)",
      "",
      REASON,
      "",
      "Позиция мен пул аккаунттарының адрестері devnet-pool.json файлына қосылды.",
      END,
    ].join("\n");
    let readme = fs.readFileSync(README_FILE, "utf8");
    const start = readme.indexOf(START);
    if (start >= 0) {
      const end = readme.indexOf(END, start);
      if (end < 0) throw new Error("README ішіндегі позиция бөлімінің аяқталу белгісі жоқ.");
      readme = readme.slice(0, start) + section + readme.slice(end + END.length);
    } else {
      readme = readme.replace(/\s*$/, "") + "\n\n" + section + "\n";
    }
    writeAtomic(README_FILE, readme.replace(/\s*$/, "") + "\n", 0o644);
    console.log("devnet-pool.json және README.md жаңартылды.");
  }

  if (saved.position) {
    if (saved.position.owner !== owner.toBase58()) {
      throw new Error("Сақталған позиция басқа әмиянға тиесілі.");
    }
    await saveResult(saved.position, saved.position.referencePrice, saved.position.tx);
    return;
  }

  const planFile = path.join(STATE_DIR, saved.poolId + "-" + owner.toBase58() + ".json");
  let plan: PositionPlan;
  if (fs.existsSync(planFile)) {
    plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
    if (plan.poolId !== saved.poolId || plan.owner !== owner.toBase58()) {
      throw new Error("Жергілікті позиция жоспары басқа пулға немесе әмиянға арналған.");
    }
  } else {
    const price = new Decimal(poolInfo.price);
    plan = {
      poolId: saved.poolId,
      owner: owner.toBase58(),
      secretKey: Array.from(Keypair.generate().secretKey),
      referencePrice: price.toString(),
      tickLower: TickUtils.getPriceAndTick({ poolInfo, price: price.mul("0.9"), baseIn: true }).tick,
      tickUpper: TickUtils.getPriceAndTick({ poolInfo, price: price.mul("1.1"), baseIn: true }).tick,
    };
    if (!simulateOnly) {
      fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      writeAtomic(planFile, JSON.stringify(plan, null, 2) + "\n", 0o600);
    }
  }
  const nftSigner = Keypair.fromSecretKey(Uint8Array.from(plan.secretKey));
  const positionId = getPdaPersonalPositionAddress(program, nftSigner.publicKey).publicKey;
  if (await connection.getAccountInfo(positionId)) {
    if (!plan.addresses) throw new Error("Жергілікті жоспарда позиция аккаунттарының адрестері жоқ.");
    await saveResult(plan.addresses, plan.referencePrice);
    return;
  }

  const lower = TickUtils.getTickPrice({ poolInfo, tick: plan.tickLower, baseIn: true }).price;
  const upper = TickUtils.getTickPrice({ poolInfo, tick: plan.tickUpper, baseIn: true }).price;
  const current = new Decimal(poolInfo.price);
  if (!lower.lt(current) || !upper.gt(current) ||
      plan.tickLower % poolInfo.config.tickSpacing !== 0 ||
      plan.tickUpper % poolInfo.config.tickSpacing !== 0) {
    throw new Error("Ағымдағы баға таңдалған тик диапазонының ішінде болуы керек.");
  }
  const amount = new BN(new Decimal(BASE_AMOUNT).mul(new Decimal(10).pow(poolInfo.mintA.decimals)).toFixed(0));
  const quote = await PoolUtils.getLiquidityAmountOutFromAmountIn({
    poolInfo, inputA: true, tickLower: plan.tickLower, tickUpper: plan.tickUpper,
    amount, slippage: SLIPPAGE, add: true, amountHasFee: true,
    epochInfo: await raydium.fetchEpochInfo(),
  });
  if (quote.liquidity.isZero()) throw new Error("Есептелген өтімділік нөлге тең.");
  await raydium.account.fetchWalletTokenAccounts();

  const { transaction, extInfo, execute } = await raydium.clmm.openPositionFromBase({
    poolInfo, poolKeys, tickLower: plan.tickLower, tickUpper: plan.tickUpper,
    base: "MintA", baseAmount: amount, otherAmountMax: quote.amountSlippageB.amount,
    ownerInfo: { useSOLBalance: false },
    nft2022: true, withMetadata: "no-create",
    getEphemeralSigners: () => [nftSigner.publicKey],
    txVersion: TxVersion.V0,
    computeBudgetConfig: { units: 600000, microLamports: 0 },
  });
  transaction.sign([nftSigner]);
  const addresses: PositionAddresses = {
    nftMint: extInfo.nftMint.toBase58(),
    personalPosition: extInfo.personalPosition.toBase58(),
    protocolPosition: extInfo.protocolPosition.toBase58(),
    tickArrayLower: extInfo.tickArrayLower.toBase58(),
    tickArrayUpper: extInfo.tickArrayUpper.toBase58(),
    positionNftAccount: extInfo.positionNftAccount.toBase58(),
  };
  console.log("Нақты диапазон —", lower.toFixed(12), "—", upper.toFixed(12));
  console.log("Тиктер —", plan.tickLower, "—", plan.tickUpper);
  console.log("Негізгі токен мөлшері —", BASE_AMOUNT);
  console.log("Екінші токеннің ең үлкен мөлшері —",
    new Decimal(quote.amountSlippageB.amount.toString()).div(new Decimal(10).pow(poolInfo.mintB.decimals)).toFixed(6));

  const simulation = await connection.simulateTransaction(transaction, {
    commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: true,
  });
  if (simulation.value.err) {
    console.error((simulation.value.logs || []).join("\n"));
    throw new Error("Симуляция қатесі — " + JSON.stringify(simulation.value.err));
  }
  console.log("Симуляция өтті, CU —", simulation.value.unitsConsumed);
  if (simulateOnly) return;

  plan.addresses = addresses;
  writeAtomic(planFile, JSON.stringify(plan, null, 2) + "\n", 0o600);
  let txId: string | undefined;
  try {
    txId = (await execute({ sendAndConfirm: true, skipPreflight: false })).txId;
  } catch (error) {
    if (!(await connection.getAccountInfo(positionId))) throw error;
  }
  await saveResult(addresses, plan.referencePrice, txId);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
