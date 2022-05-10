import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { BigNumber, Contract, providers, Wallet } from "ethers";
import { BUNDLE_EXECUTOR_ABI, UNISWAP_ROUTER02_ABI, UNISWAP_FACTORY_ABI } from "./abi";
import { UniswappyV2EthPair } from "./UniswappyV2EthPair";
import { FACTORY_ADDRESSES, TOKEN_ADDRESS_SUPPORTED, UNISWAP_FACTORY_ADDRESS, WETH_ADDRESS , BUNDLE_EXECUTOR_ADDRESS} from "./addresses";
import { Arbitrage, SwapToken, MarketsByToken } from "./Arbitrage";
import { getDefaultRelaySigningKey } from "./utils";
import { WebSocket } from 'ws';
import { JsxEmit } from "typescript";
const sockets = require('dgram');
require('dotenv').config();

const HOST_URL = process.env.HOST_URL || 'ws://localhost:1234';
const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY || getDefaultRelaySigningKey();

const FLASHBOTS_RELAY_SIGNING_KEY = process.env.FLASHBOTS_RELAY_SIGNING_KEY || getDefaultRelaySigningKey();

const MINER_REWARD_PERCENTAGE = parseInt(process.env.MINER_REWARD_PERCENTAGE || "0")

if (PRIVATE_KEY === "") {
  console.warn("Must provide PRIVATE_KEY environment variable")
  process.exit(1)
}

if (FLASHBOTS_RELAY_SIGNING_KEY === "") {
  console.warn("Must provide FLASHBOTS_RELAY_SIGNING_KEY. Please see https://github.com/flashbots/pm/blob/main/guides/searcher-onboarding.md")
  process.exit(1)
}


const provider = new providers.StaticJsonRpcProvider(ETHEREUM_RPC_URL);

const arbitrageSigningWallet = new Wallet(PRIVATE_KEY);
const flashbotsRelaySigningWallet = new Wallet(FLASHBOTS_RELAY_SIGNING_KEY);

async function getPairAddressFromRouter(swapTx: SwapToken) {
    const router = new Contract(swapTx.market, UNISWAP_ROUTER02_ABI, provider);
    const factoryAddress: string = (await router.functions.factory())[0];
    const factory = new Contract(factoryAddress, UNISWAP_FACTORY_ABI, provider);
    const pairAddress: string  = (await factory.functions.getPair(swapTx.tokenIn, swapTx.tokenOut))[0];
    return pairAddress;
}
async function checkArbitrage(swapTx: SwapToken): Promise<any> {
    if(latestBlock === undefined || latestBlock != lastUpdatedReserveBlock) {
      await UniswappyV2EthPair.updateReserves(provider, allMarketPairs);
      lastUpdatedReserveBlock = latestBlock;
    }
    console.log("routerAddress: ", swapTx.market);
    swapTx.market = await getPairAddressFromRouter(swapTx);
    console.log("pairAddress: ", swapTx.market);
    if(TOKEN_ADDRESS_SUPPORTED.hasOwnProperty(swapTx.tokenOut) && simulateMarketSwap(swapTx.tokenIn, markets, swapTx)) {
      const bestCrossedMarket = arbitrage.evaluateMarketsForToken(swapTx.tokenIn, swapTx.tokenOut, markets);
      if(bestCrossedMarket !== undefined){
        Arbitrage.printCrossedMarket(bestCrossedMarket);
        return arbitrage.getCrossedMarketTxn(bestCrossedMarket, MINER_REWARD_PERCENTAGE, swapTx.tokenOut)
      }
    } else if(TOKEN_ADDRESS_SUPPORTED.hasOwnProperty(swapTx.tokenIn) && simulateMarketSwap(swapTx.tokenOut, markets, swapTx)) {
      const bestCrossedMarket = arbitrage.evaluateMarketsForToken(swapTx.tokenOut, swapTx.tokenIn, markets);
      if(bestCrossedMarket !== undefined){
        Arbitrage.printCrossedMarket(bestCrossedMarket);
        return arbitrage.getCrossedMarketTxn(bestCrossedMarket, MINER_REWARD_PERCENTAGE, swapTx.tokenIn)
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
  const flashbotsProvider = await FlashbotsBundleProvider.create(provider, flashbotsRelaySigningWallet);
  console.log("BUNDLE_EXECUTOR_ADDRESS: ", BUNDLE_EXECUTOR_ADDRESS);
  let bundleExecuterContracts: {[key:string]: Contract} = {};
  for(const tokenAddress in  BUNDLE_EXECUTOR_ADDRESS) {
    bundleExecuterContracts[tokenAddress] = new Contract(BUNDLE_EXECUTOR_ADDRESS[tokenAddress],BUNDLE_EXECUTOR_ABI, provider);
  }
  arbitrage = new Arbitrage(
    arbitrageSigningWallet,
    flashbotsProvider,
    bundleExecuterContracts ,
    BUNDLE_EXECUTOR_ADDRESS )

  const groupedMarkets = await UniswappyV2EthPair.getUniswapMarketsByToken(provider, FACTORY_ADDRESSES);
  markets = groupedMarkets.marketsByToken;
  allMarketPairs = groupedMarkets.allMarketPairs;

  provider.on('block', async (blockNumber) => {
    latestBlock = blockNumber;
    console.log('block received: ', blockNumber);
  })
}

function simulateMarketSwap(tokenAddress: string, marketsByToken: MarketsByToken, swap: SwapToken): boolean {
  if(marketsByToken[tokenAddress] === undefined) {
    return false;
  }
  const markets = marketsByToken[tokenAddress];
  console.log("debug: swap market ", swap.market);
  for(const market of markets) {
    console.log("debug: marketAdd ", market.marketAddress)
    if(market.marketAddress == swap.market) {
      console.log("debug: simiulated");
      return market.simulateSwap(swap.tokenIn, swap.tokenOut, BigNumber.from(swap.amountIn), BigNumber.from(swap.amountOut), BigNumber.from(swap.slippage))
    }
  }
  return false
}
main();

let client = sockets.createSocket('udp4');

client.on('listening', ()=> {
  var address = client.address();
  console.log('UDP client listening on ' + address.address + ":" + address.port);
});

client.send('START', 0, 5, 1234, 'localhost', function (err: any, bytes:any) {
  if (err) throw err;
  console.log('UDP message sent to ' + 'localhost' + ':' + 1234);
});


// const ws = new WebSocket(HOST_URL);
// ws.on('open', function open() {
//   ws.send('START');
// });

client.on('message', function message(data: any, remote: any) {
  try{
      const jsonData = JSON.parse(data);
      console.log("received data", jsonData);
      checkArbitrage(jsonData)
      .then((arbData) => {
        let jsonResp = {'id': jsonData.id, 'signedTx': arbData};
        console.log(jsonResp);
        let resp = JSON.stringify(jsonResp);
        client.send(resp, 0, resp.length, 1234, 'localhost',function (err: any, bytes:any) {
          if (err) throw err;
          console.log('UDP message sent to ' + 'localhost' + ':' + 1234);
        });
      })
      .catch((e)=> {
        console.log(e);
      }); 

    } catch(e) {
      console.log(e);
    }
  });

const port = process.env.PORT || 8080;
