import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { BigNumber, Contract, providers, Wallet } from "ethers";
import { BUNDLE_EXECUTOR_ABI } from "./abi";
import { UniswappyV2EthPair } from "./UniswappyV2EthPair";
import { FACTORY_ADDRESSES, WETH_ADDRESS } from "./addresses";
import { Arbitrage, SwapToken, MarketsByToken } from "./Arbitrage";
import { getDefaultRelaySigningKey } from "./utils";
import { WebSocketServer } from 'ws';
import { JsxEmit } from "typescript";


const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL
const PRIVATE_KEY = process.env.PRIVATE_KEY || getDefaultRelaySigningKey();
const BUNDLE_EXECUTOR_ADDRESS = process.env.BUNDLE_EXECUTOR_ADDRESS || "0xda0a57b710768ae17941a9fa33f8b720c8bd9ddd"

const FLASHBOTS_RELAY_SIGNING_KEY = process.env.FLASHBOTS_RELAY_SIGNING_KEY || getDefaultRelaySigningKey();

const MINER_REWARD_PERCENTAGE = parseInt(process.env.MINER_REWARD_PERCENTAGE || "0")

if (PRIVATE_KEY === "") {
  console.warn("Must provide PRIVATE_KEY environment variable")
  process.exit(1)
}
if (BUNDLE_EXECUTOR_ADDRESS === "") {
  console.warn("Must provide BUNDLE_EXECUTOR_ADDRESS environment variable. Please see README.md")
  process.exit(1)
}

if (FLASHBOTS_RELAY_SIGNING_KEY === "") {
  console.warn("Must provide FLASHBOTS_RELAY_SIGNING_KEY. Please see https://github.com/flashbots/pm/blob/main/guides/searcher-onboarding.md")
  process.exit(1)
}

//const HEALTHCHECK_URL = process.env.HEALTHCHECK_URL || ""

const provider = new providers.StaticJsonRpcProvider(ETHEREUM_RPC_URL);

const arbitrageSigningWallet = new Wallet(PRIVATE_KEY);
const flashbotsRelaySigningWallet = new Wallet(FLASHBOTS_RELAY_SIGNING_KEY);

// function healthcheck() {
//   if (HEALTHCHECK_URL === "") {
//     return
//   }
//   get(HEALTHCHECK_URL).on('error', console.error);
// }

async function checkArbitrage(swapTx: SwapToken): Promise<any> {
    if(latestBlock != lastUpdatedReserveBlock) {
      await UniswappyV2EthPair.updateReserves(provider, allMarketPairs);
      lastUpdatedReserveBlock = latestBlock;
    }
    if(swapTx.tokenOut == WETH_ADDRESS && simulateMarketSwap(swapTx.tokenIn, markets, swapTx)) {
      const bestCrossedMarket = arbitrage.evaluateMarketsForToken(swapTx.tokenIn, markets);
      if(bestCrossedMarket !== undefined){
        Arbitrage.printCrossedMarket(bestCrossedMarket);
        return arbitrage.getCrossedMarketTxn(bestCrossedMarket, MINER_REWARD_PERCENTAGE)
      }
    } else if(swapTx.tokenIn == WETH_ADDRESS && simulateMarketSwap(swapTx.tokenOut, markets, swapTx)) {
      const bestCrossedMarket = arbitrage.evaluateMarketsForToken(swapTx.tokenOut, markets);
      if(bestCrossedMarket !== undefined){
        Arbitrage.printCrossedMarket(bestCrossedMarket);
        return arbitrage.getCrossedMarketTxn(bestCrossedMarket, MINER_REWARD_PERCENTAGE)
      }
    }
    return Promise.reject("no arbitrage")
}

let markets: MarketsByToken;
let allMarketPairs: Array<UniswappyV2EthPair>;
let arbitrage: Arbitrage;
let latestBlock: number;
let lastUpdatedReserveBlock: number;

async function main() {
  //console.log("Searcher Wallet Address: " + await arbitrageSigningWallet.getAddress())
  //console.log("Flashbots Relay Signing Wallet Address: " + await flashbotsRelaySigningWallet.getAddress())
  const flashbotsProvider = await FlashbotsBundleProvider.create(provider, flashbotsRelaySigningWallet);
  console.log("BUNDLE_EXECUTOR_ADDRESS: ", BUNDLE_EXECUTOR_ADDRESS);
  arbitrage = new Arbitrage(
    arbitrageSigningWallet,
    flashbotsProvider,
    new Contract(BUNDLE_EXECUTOR_ADDRESS, BUNDLE_EXECUTOR_ABI, provider) ,
    BUNDLE_EXECUTOR_ADDRESS    )

  const groupedMarkets = await UniswappyV2EthPair.getUniswapMarketsByToken(provider, FACTORY_ADDRESSES);
  markets = groupedMarkets.marketsByToken;
  allMarketPairs = groupedMarkets.allMarketPairs;

  provider.on('block', async (blockNumber) => {
    latestBlock = blockNumber;
    console.log('block received: ', blockNumber);
    //await UniswappyV2EthPair.updateReserves(provider, markets.allMarketPairs);
    // const bestCrossedMarkets = await arbitrage.evaluateMarkets(markets.marketsByToken);
    // if (bestCrossedMarkets.length === 0) {
    //   console.log("No crossed markets")
    //   return
    // }
    // bestCrossedMarkets.forEach(Arbitrage.printCrossedMarket);
    // arbitrage.takeCrossedMarkets(bestCrossedMarkets, blockNumber, MINER_REWARD_PERCENTAGE).then(healthcheck).catch(console.error)
  })
}

function simulateMarketSwap(tokenAddress: string, marketsByToken: MarketsByToken, swap: SwapToken): boolean {
  if(marketsByToken[tokenAddress] === undefined) {
    return false;
  }

  const markets = marketsByToken[tokenAddress];

  for(const market of markets) {
    if(market.marketAddress == swap.market) {
      return market.simulateSwap(swap.tokenIn, swap.tokenOut, swap.amountIn, swap.amountOut, BigNumber.from(swap.slippage))
    }
  }
  return false
}
main();

const wss = new WebSocketServer({port: 8080});

wss.on('connection', function connection(ws) {
  ws.on('message', function message(data: any) {
    try{
      const jsonData = JSON.parse(data);
      checkArbitrage(jsonData)
      .then((arbData) => {
        console.log(arbData);
        ws.send(JSON.stringify(arbData));
      })
      .catch((e)=> {
        console.log(e);
      }); 

    } catch(e) {
      console.log(e);
    }
    
  });
});

const port = process.env.PORT || 8080;
