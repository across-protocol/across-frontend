import { clients, across } from "@uma/sdk";
import { BridgePoolEthers__factory } from "@uma/contracts-frontend";
import { ethers, BigNumber } from "ethers";

import {
  ADDRESSES,
  CHAINS,
  ChainId,
  PROVIDERS,
  TOKENS_LIST,
  RATE_MODELS,
} from "./constants";
import { isValidString, parseEther } from "./format";

export function getDepositBox(
  chainId: ChainId,
  signer?: ethers.Signer
): clients.bridgeDepositBox.Instance {
  const maybeAddress = ADDRESSES[chainId].BRIDGE;
  if (!isValidString(maybeAddress)) {
    throw new Error(
      `Deposit Box not supported on ${CHAINS[chainId].name} with chainId: ${chainId}`
    );
  }
  return clients.bridgeDepositBox.connect(
    maybeAddress,
    signer ?? PROVIDERS[chainId]()
  );
}

const { constants, gasFeeCalculator } = across;

// currently available constants
const {
  FAST_ETH_GAS,
  FAST_ERC_GAS,
  FAST_UMA_GAS,
  SLOW_ETH_GAS,
  SLOW_ERC_GAS,
  SLOW_UMA_GAS,
} = constants;

export type Fee = {
  total: ethers.BigNumber;
  pct: ethers.BigNumber;
};

type RelayFees = {
  instantRelayFee: Fee;
  slowRelayFee: Fee;
};

export type BridgeFees = {
  instantRelayFee: Fee;
  slowRelayFee: Fee;
  lpFee: Fee;
};

export async function getRelayFees(
  token: string,
  amount: ethers.BigNumber
): Promise<RelayFees & { isAmountTooLow: boolean }> {
  const l1Equivalent = TOKENS_LIST[ChainId.MAINNET].find(
    (t) => t.symbol === token
  )?.address;
  if (!l1Equivalent) {
    throw new Error(`Token ${token} not found in TOKENS_LIST`);
  }
  const provider = PROVIDERS[ChainId.MAINNET]();
  const gasAmountFast =
    token === "ETH"
      ? FAST_ETH_GAS - SLOW_ETH_GAS
      : token === "UMA"
      ? FAST_UMA_GAS - SLOW_UMA_GAS
      : FAST_ERC_GAS - SLOW_ERC_GAS;

  const gasAmountSlow =
    token === "ETH"
      ? SLOW_ETH_GAS
      : token === "UMA"
      ? SLOW_UMA_GAS
      : SLOW_ERC_GAS;

  const DISCOUNT = 0.25;
  const gasAmountSlowWithDiscount = Math.floor(gasAmountSlow * (1 - DISCOUNT));
  const gasAmountFastWithDiscount = Math.floor(gasAmountFast * (1 - DISCOUNT));

  const gasFeesSlow = await gasFeeCalculator(
    provider,
    amount,
    gasAmountSlowWithDiscount,
    l1Equivalent === ethers.constants.AddressZero ? undefined : l1Equivalent
  );
  const gasFeesFast = await gasFeeCalculator(
    provider,
    amount,
    gasAmountFastWithDiscount,
    l1Equivalent === ethers.constants.AddressZero ? undefined : l1Equivalent
  );

  const totalFees = ethers.BigNumber.from(gasFeesSlow.gasFees).add(
    gasFeesFast.gasFees
  );

  // amount*0.25 <= totalFees <==> amount*25 <= totalFees * 100
  const isFeeMoreThan25Percent = amount.mul(25).lte(totalFees.mul(100));

  return {
    instantRelayFee: {
      pct: ethers.BigNumber.from(gasFeesFast.feesAsPercent),
      total: ethers.BigNumber.from(gasFeesFast.gasFees),
    },
    slowRelayFee: {
      pct: ethers.BigNumber.from(gasFeesSlow.feesAsPercent),
      total: ethers.BigNumber.from(gasFeesSlow.gasFees),
    },
    isAmountTooLow: isFeeMoreThan25Percent,
  };
}

const { calculateRealizedLpFeePct } = across.feeCalculator;
export async function getLpFee(
  tokenSymbol: string,
  amount: ethers.BigNumber
): Promise<Fee & { isLiquidityInsufficient: boolean }> {
  const provider = PROVIDERS[ChainId.MAINNET]();
  const l1EqInfo = TOKENS_LIST[ChainId.MAINNET].find(
    (t) => t.symbol === tokenSymbol
  );
  if (!l1EqInfo) {
    throw new Error(`Token ${tokenSymbol} not found in TOKENS_LIST`);
  }
  if (amount.lte(0)) {
    throw new Error(`Amount must be greater than 0.`);
  }
  if (!RATE_MODELS[tokenSymbol]) {
    throw new Error(`Rate model for ${tokenSymbol} not found.`);
  }
  const { bridgePool: bridgePoolAddress } = l1EqInfo;
  const bridgePool = BridgePoolEthers__factory.connect(
    bridgePoolAddress,
    provider
  );

  const [currentUt, nextUt] = await Promise.all([
    bridgePool.callStatic.liquidityUtilizationCurrent(),
    bridgePool.callStatic.liquidityUtilizationPostRelay(amount),
  ]);

  const result = {
    pct: BigNumber.from(0),
    total: BigNumber.from(0),
    isLiquidityInsufficient: false,
  };
  if (!currentUt.eq(nextUt)) {
    result.pct = calculateRealizedLpFeePct(
      RATE_MODELS[tokenSymbol],
      currentUt,
      nextUt
    );
    result.total = amount.mul(result.pct).div(parseEther("1"));
  }
  const liquidityReserves = await bridgePool.liquidReserves();
  const pendingReserves = await bridgePool.pendingReserves();

  const isLiquidityInsufficient = liquidityReserves
    .sub(pendingReserves)
    .lte(amount);
  result.isLiquidityInsufficient = isLiquidityInsufficient;
  return result;
}

export const getEstimatedDepositTime = (chainId: ChainId) => {
  switch (chainId) {
    case ChainId.OPTIMISM:
    case ChainId.BOBA:
      return '~20 minutes';
    case ChainId.ARBITRUM:
      return '~10 minutes';
    case ChainId.MAINNET:
      return '~1-3 minutes';
  }
};

export const getConfirmationDepositTime = (chainId: ChainId) => {
  switch (chainId) {
    case ChainId.OPTIMISM:
    case ChainId.BOBA:
      return '~20 minutes';
    case ChainId.ARBITRUM:
      return '~10 minutes';
    case ChainId.MAINNET:
      return '~2 minutes';
  }
};

// This will be moved inside the SDK in the near future
export const optimismErc20Pairs = () => {
  const usdcMainnet = TOKENS_LIST[ChainId.MAINNET].filter((token) => token.symbol = "USDC")[0];
  const umaMainnet = TOKENS_LIST[ChainId.MAINNET].filter((token) => token.symbol = "UMA")[0];
  const usdcOptimism = TOKENS_LIST[ChainId.OPTIMISM].filter((token) => token.symbol = "USDC")[0];
  const umaOptimism = TOKENS_LIST[ChainId.OPTIMISM].filter((token) => token.symbol = "UMA")[0];

  return {
    [usdcMainnet.address]: usdcOptimism.address,
    [umaMainnet.address]: umaOptimism.address,
  };
};
