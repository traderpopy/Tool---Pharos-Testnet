require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const axios = require('axios');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const colors = require('colors');

const networkConfig = {
    name: "Pharos Testnet",
    chainId: 688688,
    rpcUrl: "https://testnet.dplabs-internal.com",
};

const TOKENS = {
    USDC: { address: "0x72df0bcd7276f2dfbac900d1ce63c272c4bccced", decimals: 6 },
    USDT: { address: "0xD4071393f8716661958F766DF660033b3d35fD29", decimals: 6 },
    WBTC: { address: "0x8275c526d1bcec59a31d673929d3ce8d108ff5c7", decimals: 18 },
    WPHRS: { address: "0x76aaada469d23216be5f7c596fa25f282ff9b364", decimals: 18 },
    NATIVE_PHRS: { address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", decimals: 18 }
};

const DODO_ROUTER_ADDRESS = "0x4b177aded3b8bd1d5d747f91b9e853513838cd49";
const DODO_ROUTER_ADDRESS2 = "0x73cafc894dbfc181398264934f7be4e482fc9d40";

const LIQUIDITY_POOLS = [
    {
        name: "USDC/USDT",
        dvmAddress: "0xff7129709ebd3485c4ed4fef6dd923025d24e730",
        baseToken: TOKENS.USDC,
        quoteToken: TOKENS.USDT,
        baseInAmount: "328650", // 0.328650 USDC
        quoteInAmount: "1000000", // 1 USDT
        baseMinAmount: "328321", // slippage protection
        quoteMinAmount: "998000", // slippage protection
    },
    {
        name: "USDT/USDC",
        dvmAddress: "0xdc2ae67639eface5475bbb23523c0def25fc8c84",
        baseToken: TOKENS.USDT,
        quoteToken: TOKENS.USDC,
        baseInAmount: "18449", // 0.018449 USDT
        quoteInAmount: "100000", // 0.1 USDC
        baseMinAmount: "18430", // slippage protection
        quoteMinAmount: "99900", // slippage protection
    }
];

const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function deposit() payable"
];

const DODO_ROUTER_ABI = [
    "function addDVMLiquidity(address dvmAddress, uint256 baseInAmount, uint256 quoteInAmount, uint256 baseMinAmount, uint256 quoteMinAmount, uint8 flag, uint256 deadLine) payable"
];

const maxThreads = 10;
const THREAD_TIMEOUT = 30 * 60 * 1000;
const SWAP_CYCLES = 5; // so lan swap

class DODOSwapBot {
    constructor(accountIndex = 0, privateKey = null, proxyIP = null) {
        this.provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
        this.wallet = privateKey ? new ethers.Wallet(privateKey, this.provider) : null;
        this.accountIndex = accountIndex;
        this.proxyIP = proxyIP;
    }

    async log(msg, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const accountPrefix = `[Tài khoản ${this.accountIndex + 1}]`;
        const ipPrefix = this.proxyIP ? `[${this.proxyIP}]` : '';
        let logMessage = `${timestamp} ${accountPrefix}${ipPrefix} ${msg}`;

        switch (type) {
            case 'success':
                console.log(logMessage.green);
                break;
            case 'error':
                console.log(logMessage.red);
                break;
            case 'warning':
                console.log(logMessage.yellow);
                break;
            default:
                console.log(logMessage.blue);
        }
    }

    async getDODORoute(fromToken, toToken, amount, userAddress, slippage = 3) {
        try {
            const deadline = Math.floor(Date.now() / 1000) + 1200;
            const url = `https://api.dodoex.io/route-service/v2/widget/getdodoroute`;
            const params = {
                chainId: networkConfig.chainId,
                deadLine: deadline,
                apikey: process.env.DODO_API_KEY || "a37546505892e1a952",
                slippage: slippage,
                source: "dodoV2AndMixWasm",
                toTokenAddress: toToken,
                fromTokenAddress: fromToken,
                userAddr: userAddress,
                estimateGas: true,
                fromAmount: amount.toString()
            };

            await this.log(`Đang tìm router để swap từ ${fromToken} -> ${toToken}`, 'info');
            const response = await axios.get(url, {
                params,
                headers: {
                    'accept': 'application/json, text/plain, */*',
                    'accept-encoding': 'gzip, deflate, br, zstd',
                    'accept-language': 'vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5',
                    'origin': 'https://faroswap.xyz',
                    'referer': 'https://faroswap.xyz/',
                    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
                }
            });

            if (response.data.status === 200) {
                return response.data.data;
            } else {
                throw new Error(`Lỗi API: ${response.data.status}`);
            }
        } catch (error) {
            await this.log(`Lỗi rồi: ${error.message}`, 'error');
            throw error;
        }
    }

    async executeSwap(routeData) {
        try {
            if (!routeData.to || !routeData.data || !routeData.value) {
                throw new Error('Router không hợp lệ');
            }

            const value = BigInt(routeData.value);
            const tx = {
                to: routeData.to,
                data: routeData.data,
                value: value,
                gasLimit: routeData.gasLimit ? BigInt(routeData.gasLimit) : 500000
            };

            await this.log(`Đang thực hiện swap cho ví: ${this.wallet.address}`, 'info');
            const transaction = await this.wallet.sendTransaction(tx);
            await this.log(`Giao dịch swap đã gửi: ${transaction.hash}`, 'info');
            const receipt = await transaction.wait();
            await this.log(`Swap được xác nhận tại block: ${receipt.blockNumber}`, 'success');
            return receipt;
        } catch (error) {
            await this.log(`Lỗi khi thực hiện swap: ${error.message}`, 'error');
            throw error;
        }
    }

    async approveToken(tokenAddress, spenderAddress, amount) {
        try {
            const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.wallet);
            const currentAllowance = await tokenContract.allowance(this.wallet.address, spenderAddress);
            const amountBN = BigInt(amount);

            if (currentAllowance < amountBN) {
                await this.log(`Đang phê duyệt ${tokenAddress} cho ${spenderAddress}`, 'info');
                if (currentAllowance > 0) {
                    const resetTx = await tokenContract.approve(spenderAddress, 0);
                    await resetTx.wait();
                    await this.log(`Đã đặt lại quyền phê duyệt: ${resetTx.hash}`, 'success');
                }
                const maxAmount = ethers.MaxUint256;
                const tx = await tokenContract.approve(spenderAddress, maxAmount);
                await tx.wait();
                await this.log(`Phê duyệt thành công: ${tx.hash}`, 'success');
            } else {
                await this.log(`Token ${tokenAddress} đã được phê duyệt`, 'info');
            }
        } catch (error) {
            await this.log(`Lỗi khi phê duyệt token: ${error.message}`, 'error');
            throw error;
        }
    }

    async getTokenBalance(tokenAddress) {
        try {
            if (tokenAddress === TOKENS.NATIVE_PHRS.address) {
                return await this.provider.getBalance(this.wallet.address);
            } else {
                const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.wallet);
                return await tokenContract.balanceOf(this.wallet.address);
            }
        } catch (error) {
            await this.log(`Lỗi khi lấy số dư token ${tokenAddress}: ${error.message}`, 'error');
            return 0n;
        }
    }

    formatBalance(balance, decimals) {
        return ethers.formatUnits(balance, decimals);
    }

    async checkSufficientBalance(poolConfig) {
        try {
            const baseBalance = await this.getTokenBalance(poolConfig.baseToken.address);
            const quoteBalance = await this.getTokenBalance(poolConfig.quoteToken.address);
            const baseRequired = BigInt(poolConfig.baseInAmount);
            const quoteRequired = BigInt(poolConfig.quoteInAmount);

            await this.log(`Kiểm tra số dư cho ${poolConfig.name}`, 'info');
            await this.log(`Token cơ bản (${poolConfig.baseToken.address}): Hiện có: ${this.formatBalance(baseBalance, poolConfig.baseToken.decimals)}, Cần: ${this.formatBalance(baseRequired, poolConfig.baseToken.decimals)}, Đủ: ${baseBalance >= baseRequired ? '✅' : '❌'}`, 'info');
            await this.log(`Token định giá (${poolConfig.quoteToken.address}): Hiện có: ${this.formatBalance(quoteBalance, poolConfig.quoteToken.decimals)}, Cần: ${this.formatBalance(quoteRequired, poolConfig.quoteToken.decimals)}, Đủ: ${quoteBalance >= quoteRequired ? '✅' : '❌'}`, 'info');

            return {
                baseBalance,
                quoteBalance,
                baseRequired,
                quoteRequired,
                baseSufficient: baseBalance >= baseRequired,
                quoteSufficient: quoteBalance >= quoteRequired,
                bothSufficient: baseBalance >= baseRequired && quoteBalance >= quoteRequired
            };
        } catch (error) {
            await this.log(`Lỗi khi kiểm tra số dư cho ${poolConfig.name}: ${error.message}`, 'error');
            return null;
        }
    }

    async swapPHRSForToken(targetTokenAddress, requiredAmount, tokenDecimals, maxRetries = 3) {
        try {
            const phrsBalance = await this.getTokenBalance(TOKENS.NATIVE_PHRS.address);
            const minPHRSForGas = ethers.parseEther("0.05");

            if (phrsBalance <= minPHRSForGas) {
                await this.log(`Số dư PHRS không đủ để swap. Hiện có: ${ethers.formatEther(phrsBalance)}, Cần giữ lại: ${ethers.formatEther(minPHRSForGas)} cho phí gas`, 'error');
                return false;
            }

            let slippage = 3;
            let attempt = 0;
            let swapSuccess = false;
            let swapAmount = ethers.parseEther("0.01");

            while (attempt < maxRetries && !swapSuccess) {
                attempt++;
                await this.log(`Lần thử ${attempt}/${maxRetries}: Đang swap ${ethers.formatEther(swapAmount)} PHRS sang ${targetTokenAddress}`, 'info');

                const availableForSwap = phrsBalance - minPHRSForGas;
                if (swapAmount > availableForSwap) {
                    await this.log(`Không đủ PHRS để swap. Cần: ${ethers.formatEther(swapAmount)}, Hiện có: ${ethers.formatEther(availableForSwap)}`, 'error');
                    return false;
                }

                const routeData = await this.getDODORoute(
                    TOKENS.NATIVE_PHRS.address,
                    targetTokenAddress,
                    swapAmount.toString(),
                    this.wallet.address,
                    slippage
                );

                if (!routeData || !routeData.to || !routeData.data || !routeData.value) {
                    await this.log(`Không thể lấy router swap hợp lệ cho ${targetTokenAddress}`, 'error');
                    return false;
                }

                const expectedReturn = routeData.minReturnAmount ? BigInt(routeData.minReturnAmount) : 0n;
                await this.log(`Số lượng kỳ vọng nhận được: ${this.formatBalance(expectedReturn, tokenDecimals)} ${targetTokenAddress}`, 'info');

                if (targetTokenAddress !== TOKENS.NATIVE_PHRS.address) {
                    await this.approveToken(targetTokenAddress, routeData.to, expectedReturn || requiredAmount);
                }

                let gasEstimate;
                try {
                    gasEstimate = await this.wallet.estimateGas({
                        to: routeData.to,
                        data: routeData.data,
                        value: routeData.value
                    });
                    await this.log(`Ước tính phí gas: ${gasEstimate.toString()}`, 'info');
                } catch (gasError) {
                    await this.log(`Ước tính phí gas thất bại: ${gasError.message}`, 'error');
                    swapAmount = (swapAmount * 80n) / 100n;
                    slippage += 1;
                    continue;
                }

                const receipt = await this.executeSwap(routeData);
                if (receipt) {
                    await this.log(`Swap hoàn tất thành công`, 'success');
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    const newBalance = await this.getTokenBalance(targetTokenAddress);
                    await this.log(`Số dư token mới: ${this.formatBalance(newBalance, tokenDecimals)}`, 'info');

                    if (newBalance >= requiredAmount) {
                        swapSuccess = true;
                    } else {
                        await this.log(`Swap cung cấp không đủ token: ${this.formatBalance(newBalance, tokenDecimals)} < ${this.formatBalance(requiredAmount, tokenDecimals)}`, 'warning');
                        swapAmount = (swapAmount * 110n) / 100n;
                        slippage += 1;
                    }
                } else {
                    await this.log(`Giao dịch swap thất bại`, 'error');
                    swapAmount = (swapAmount * 80n) / 100n;
                    slippage += 1;
                }
            }

            return swapSuccess;
        } catch (error) {
            await this.log(`Lỗi khi swap PHRS sang token ${targetTokenAddress}: ${error.message}`, 'error');
            return false;
        }
    }

    async swapTokensToPHRS(tokenAddress, tokenDecimals, maxRetries = 3) {
        try {
            const tokenBalance = await this.getTokenBalance(tokenAddress);
            const minBalance = ethers.parseUnits("0.0001", tokenDecimals);
            const amountToSwap = (tokenBalance * 98n) / 100n;

            if (amountToSwap < minBalance) {
                await this.log(`Số dư token ${tokenAddress} quá thấp để swap: ${this.formatBalance(tokenBalance, tokenDecimals)}`, 'warning');
                return false;
            }

            const phrsBalance = await this.getTokenBalance(TOKENS.NATIVE_PHRS.address);
            const minPHRSForGas = ethers.parseEther("0.05");

            if (phrsBalance <= minPHRSForGas) {
                await this.log(`Số dư PHRS không đủ để swap. Hiện có: ${ethers.formatEther(phrsBalance)}, Cần giữ lại: ${ethers.formatEther(minPHRSForGas)} cho phí gas`, 'error');
                return false;
            }

            let slippage = 3;
            let attempt = 0;
            let swapSuccess = false;

            while (attempt < maxRetries && !swapSuccess) {
                attempt++;
                await this.log(`Lần thử ${attempt}/${maxRetries}: Đang swap ${this.formatBalance(amountToSwap, tokenDecimals)} token ${tokenAddress} sang PHRS`, 'info');

                const routeData = await this.getDODORoute(
                    tokenAddress,
                    TOKENS.NATIVE_PHRS.address,
                    amountToSwap.toString(),
                    this.wallet.address,
                    slippage
                );

                if (!routeData || !routeData.to || !routeData.data || !routeData.value) {
                    await this.log(`Không thể lấy router swap hợp lệ từ ${tokenAddress} sang PHRS`, 'error');
                    return false;
                }

                await this.approveToken(tokenAddress, routeData.to, amountToSwap);

                let gasEstimate;
                try {
                    gasEstimate = await this.wallet.estimateGas({
                        to: routeData.to,
                        data: routeData.data,
                        value: routeData.value
                    });
                    await this.log(`Ước tính phí gas: ${gasEstimate.toString()}`, 'info');
                } catch (gasError) {
                    await this.log(`Ước tính phí gas thất bại: ${gasError.message}`, 'error');
                    slippage += 1;
                    continue;
                }

                const receipt = await this.executeSwap(routeData);
                if (receipt) {
                    await this.log(`Swap hoàn tất thành công`, 'success');
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    const newPhrsBalance = await this.getTokenBalance(TOKENS.NATIVE_PHRS.address);
                    await this.log(`Số dư PHRS mới: ${ethers.formatEther(newPhrsBalance)}`, 'info');
                    swapSuccess = true;
                } else {
                    await this.log(`Giao dịch swap thất bại`, 'error');
                    slippage += 1;
                }
            }

            return swapSuccess;
        } catch (error) {
            await this.log(`Lỗi khi swap token ${tokenAddress} sang PHRS: ${error.message}`, 'error');
            return false;
        }
    }

    async ensureSufficientTokens(poolConfig) {
        try {
            const balanceCheck = await this.checkSufficientBalance(poolConfig);
            if (!balanceCheck) {
                await this.log(`Không thể kiểm tra số dư cho ${poolConfig.name}`, 'error');
                return false;
            }

            if (balanceCheck.bothSufficient) {
                await this.log(`Đã có đủ token cho ${poolConfig.name}`, 'success');
                return true;
            }

            await this.log(`Phát hiện thiếu token. Đang cố gắng lấy thêm token...`, 'warning');
            let success = true;

            if (!balanceCheck.baseSufficient && poolConfig.baseToken.address !== TOKENS.NATIVE_PHRS.address) {
                const shortfall = balanceCheck.baseRequired - balanceCheck.baseBalance;
                await this.log(`Thiếu token cơ bản: ${this.formatBalance(shortfall, poolConfig.baseToken.decimals)}`, 'info');
                const swapSuccess = await this.swapPHRSForToken(
                    poolConfig.baseToken.address,
                    shortfall,
                    poolConfig.baseToken.decimals
                );
                if (!swapSuccess) {
                    await this.log(`Không thể lấy đủ token cơ bản`, 'error');
                    success = false;
                }
            }

            if (!balanceCheck.quoteSufficient && poolConfig.quoteToken.address !== TOKENS.NATIVE_PHRS.address) {
                const shortfall = balanceCheck.quoteRequired - balanceCheck.quoteBalance;
                await this.log(`Thiếu token định giá: ${this.formatBalance(shortfall, poolConfig.quoteToken.decimals)}`, 'info');
                const swapSuccess = await this.swapPHRSForToken(
                    poolConfig.quoteToken.address,
                    shortfall,
                    poolConfig.quoteToken.decimals
                );
                if (!swapSuccess) {
                    await this.log(`Không thể lấy đủ token định giá`, 'error');
                    success = false;
                }
            }

            if (success) {
                const finalCheck = await this.checkSufficientBalance(poolConfig);
                if (finalCheck && finalCheck.bothSufficient) {
                    await this.log(`Đã lấy đủ tất cả token cần thiết cho ${poolConfig.name}`, 'success');
                    return true;
                } else {
                    await this.log(`Vẫn thiếu token sau khi thử swap`, 'error');
                    return false;
                }
            }

            return false;
        } catch (error) {
            await this.log(`Lỗi khi đảm bảo đủ token: ${error.message}`, 'error');
            return false;
        }
    }

    async addLiquidity(poolConfig) {
        try {
            const dodoRouter = new ethers.Contract(DODO_ROUTER_ADDRESS, DODO_ROUTER_ABI, this.wallet);
            await this.log(`Đang thêm thanh khoản vào ${poolConfig.name}`, 'info');

            if (poolConfig.baseToken.address !== TOKENS.NATIVE_PHRS.address) {
                await this.approveToken(poolConfig.baseToken.address, DODO_ROUTER_ADDRESS2, poolConfig.baseInAmount);
            }
            if (poolConfig.quoteToken.address !== TOKENS.NATIVE_PHRS.address) {
                await this.approveToken(poolConfig.quoteToken.address, DODO_ROUTER_ADDRESS2, poolConfig.quoteInAmount);
            }

            const deadline = Math.floor(Date.now() / 1000) + 1200;
            let value = "0";
            if (poolConfig.baseToken.address === TOKENS.NATIVE_PHRS.address) {
                value = poolConfig.baseInAmount;
            } else if (poolConfig.quoteToken.address === TOKENS.NATIVE_PHRS.address) {
                value = poolConfig.quoteInAmount;
            }

            let gasEstimate;
            try {
                gasEstimate = await dodoRouter.addDVMLiquidity.estimateGas(
                    poolConfig.dvmAddress,
                    poolConfig.baseInAmount,
                    poolConfig.quoteInAmount,
                    poolConfig.baseMinAmount,
                    poolConfig.quoteMinAmount,
                    0,
                    deadline,
                    { value: value }
                );
                await this.log(`Ước tính phí gas: ${gasEstimate.toString()}`, 'info');
            } catch (gasError) {
                await this.log(`Ước tính phí gas thất bại: ${gasError.message}`, 'error');
                const reducedBaseAmount = (BigInt(poolConfig.baseInAmount) * 80n) / 100n;
                const reducedQuoteAmount = (BigInt(poolConfig.quoteInAmount) * 80n) / 100n;
                const reducedBaseMin = (BigInt(poolConfig.baseMinAmount) * 80n) / 100n;
                const reducedQuoteMin = (BigInt(poolConfig.quoteMinAmount) * 80n) / 100n;
                let reducedValue = "0";
                if (poolConfig.baseToken.address === TOKENS.NATIVE_PHRS.address) {
                    reducedValue = reducedBaseAmount.toString();
                } else if (poolConfig.quoteToken.address === TOKENS.NATIVE_PHRS.address) {
                    reducedValue = reducedQuoteAmount.toString();
                }

                try {
                    gasEstimate = await dodoRouter.addDVMLiquidity.estimateGas(
                        poolConfig.dvmAddress,
                        reducedBaseAmount.toString(),
                        reducedQuoteAmount.toString(),
                        reducedBaseMin.toString(),
                        reducedQuoteMin.toString(),
                        0,
                        deadline,
                        { value: reducedValue }
                    );
                    await this.log(`Ước tính phí gas giảm: ${gasEstimate.toString()}`, 'info');
                    const tx = await dodoRouter.addDVMLiquidity(
                        poolConfig.dvmAddress,
                        reducedBaseAmount.toString(),
                        reducedQuoteAmount.toString(),
                        reducedBaseMin.toString(),
                        reducedQuoteMin.toString(),
                        0,
                        deadline,
                        { value: reducedValue, gasLimit: (gasEstimate * 120n) / 100n }
                    );
                    await this.log(`Giao dịch thanh khoản đã gửi với số lượng giảm: ${tx.hash}`, 'success');
                    const receipt = await tx.wait();
                    await this.log(`Đã thêm thanh khoản thành công tại block: ${receipt.blockNumber}`, 'success');
                    return receipt;
                } catch (reducedError) {
                    await this.log(`Thất bại ngay cả với số lượng giảm: ${reducedError.message}`, 'error');
                    return null;
                }
            }

            const tx = await dodoRouter.addDVMLiquidity(
                poolConfig.dvmAddress,
                poolConfig.baseInAmount,
                poolConfig.quoteInAmount,
                poolConfig.baseMinAmount,
                poolConfig.quoteMinAmount,
                0,
                deadline,
                { value: value, gasLimit: (gasEstimate * 120n) / 100n }
            );

            await this.log(`Giao dịch thanh khoản đã gửi: ${tx.hash}`, 'success');
            const receipt = await tx.wait();
            await this.log(`Đã thêm thanh khoản thành công tại block: ${receipt.blockNumber}`, 'success');
            return receipt;
        } catch (error) {
            await this.log(`Lỗi khi thêm thanh khoản vào ${poolConfig.name}: ${error.message}`, 'error');
            return null;
        }
    }

    async performSwaps() {
        const swapPairs = [
            { from: TOKENS.NATIVE_PHRS.address, to: TOKENS.USDC.address, decimals: TOKENS.USDC.decimals, name: "PHRS -> USDC" },
            { from: TOKENS.USDC.address, to: TOKENS.NATIVE_PHRS.address, decimals: TOKENS.NATIVE_PHRS.decimals, name: "USDC -> PHRS" },
            { from: TOKENS.NATIVE_PHRS.address, to: TOKENS.USDT.address, decimals: TOKENS.USDT.decimals, name: "PHRS -> USDT" },
            { from: TOKENS.USDT.address, to: TOKENS.NATIVE_PHRS.address, decimals: TOKENS.NATIVE_PHRS.decimals, name: "USDT -> PHRS" }
        ];

        for (const pair of swapPairs) {
            await this.log(`Bắt đầu ${SWAP_CYCLES} lần swap cho ${pair.name}`, 'info');
            for (let i = 1; i <= SWAP_CYCLES; i++) {
                try {
                    await this.log(`Swap ${i}/${SWAP_CYCLES} cho ${pair.name}`, 'info');
                    
                    let amount;
                    if (pair.from === TOKENS.NATIVE_PHRS.address) {
                        const phrsBalance = await this.getTokenBalance(TOKENS.NATIVE_PHRS.address);
                        amount = (phrsBalance * 1n) / 1000n; // 0.1% = 1/1000
                        if (amount < ethers.parseEther("0.0001")) {
                            await this.log(`Số dư PHRS quá thấp để swap 0.1%: ${ethers.formatEther(phrsBalance)}`, 'error');
                            continue;
                        }
                    } else {
                        const tokenBalance = await this.getTokenBalance(pair.from);
                        amount = (tokenBalance * 98n) / 100n; // 98%
                        if (amount < ethers.parseUnits("0.0001", pair.decimals)) {
                            await this.log(`Số dư token quá thấp để swap 98%: ${this.formatBalance(tokenBalance, pair.decimals)}`, 'error');
                            continue;
                        }
                    }

                    const routeData = await this.getDODORoute(pair.from, pair.to, amount.toString(), this.wallet.address);
                    if (pair.from !== TOKENS.NATIVE_PHRS.address) {
                        await this.approveToken(pair.from, routeData.to, amount);
                    }
                    await this.executeSwap(routeData);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                } catch (error) {
                    await this.log(`Swap ${i}/${SWAP_CYCLES} cho ${pair.name} thất bại: ${error.message}`, 'error');
                }
            }
        }
    }

    async processLiquidityAddition(poolConfig) {
        try {
            await this.log(`Đang xử lý ${poolConfig.name}`, 'info');
            const phrsBalance = await this.getTokenBalance(TOKENS.NATIVE_PHRS.address);
            const minPHRSRequired = ethers.parseEther("0.1");

            if (phrsBalance < minPHRSRequired) {
                await this.log(`Số dư PHRS không đủ cho ${poolConfig.name}. Cần: ${ethers.formatEther(minPHRSRequired)}, Hiện có: ${ethers.formatEther(phrsBalance)}`, 'error');
                return null;
            }

            const tokensReady = await this.ensureSufficientTokens(poolConfig);
            if (!tokensReady) {
                await this.log(`Không thể lấy đủ token cho ${poolConfig.name}`, 'error');
                return null;
            }

            const result = await this.addLiquidity(poolConfig);
            if (result) {
                await this.log(`Đã thêm thanh khoản thành công vào ${poolConfig.name}`, 'success');
                const finalBaseBalance = await this.getTokenBalance(poolConfig.baseToken.address);
                const finalQuoteBalance = await this.getTokenBalance(poolConfig.quoteToken.address);
                const finalPhrsBalance = await this.getTokenBalance(TOKENS.NATIVE_PHRS.address);
                await this.log(`Số dư cuối: Cơ bản: ${this.formatBalance(finalBaseBalance, poolConfig.baseToken.decimals)}, Định giá: ${this.formatBalance(finalQuoteBalance, poolConfig.quoteToken.decimals)}, PHRS: ${ethers.formatEther(finalPhrsBalance)}`, 'info');
                return result;
            } else {
                await this.log(`Thêm thanh khoản vào ${poolConfig.name} thất bại`, 'error');
                return null;
            }
        } catch (error) {
            await this.log(`Lỗi khi xử lý thêm thanh khoản cho ${poolConfig.name}: ${error.message}`, 'error');
            return null;
        }
    }

    async validateTokenContract(tokenAddress) {
        try {
            if (tokenAddress === TOKENS.NATIVE_PHRS.address) {
                await this.log(`Token PHRS - OK`, 'success');
                return true;
            }
            const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
            const decimals = await tokenContract.decimals();
            await this.log(`Token ${tokenAddress} - Số thập phân: ${decimals}`, 'success');
            return true;
        } catch (error) {
            await this.log(`Hợp đồng token không hợp lệ ${tokenAddress}: ${error.message}`, 'error');
            return false;
        }
    }

    async displayWalletOverview() {
        try {
            await this.log(`Đang lấy thông tin ví: ${this.wallet.address}`, 'info');
            const phrsBalance = await this.getTokenBalance(TOKENS.NATIVE_PHRS.address);
            const wphrsBalance = await this.getTokenBalance(TOKENS.WPHRS.address);
            const usdcBalance = await this.getTokenBalance(TOKENS.USDC.address);
            const usdtBalance = await this.getTokenBalance(TOKENS.USDT.address);
            const wbtcBalance = await this.getTokenBalance(TOKENS.WBTC.address);

            await this.log(`Số dư token:`, 'info');
            await this.log(`- PHRS: ${ethers.formatEther(phrsBalance)}`, 'info');
            await this.log(`- WPHRS: ${ethers.formatEther(wphrsBalance)}`, 'info');
            await this.log(`- USDC: ${ethers.formatUnits(usdcBalance, 6)}`, 'info');
            await this.log(`- USDT: ${ethers.formatUnits(usdtBalance, 6)}`, 'info');
            await this.log(`- WBTC: ${ethers.formatUnits(wbtcBalance, 18)}`, 'info');

            return {
                nativePhrs: phrsBalance,
                wphrs: wphrsBalance,
                usdc: usdcBalance,
                usdt: usdtBalance,
                wbtc: wbtcBalance
            };
        } catch (error) {
            await this.log(`Lỗi khi hiển thị số dư ví: ${error.message}`, 'error');
            return null;
        }
    }

    async runWorker() {
        try {
            await this.validateTokenContract(TOKENS.NATIVE_PHRS.address);
            await this.validateTokenContract(TOKENS.USDC.address);
            await this.validateTokenContract(TOKENS.USDT.address);
            await this.validateTokenContract(TOKENS.WPHRS.address);
            await this.validateTokenContract(TOKENS.WBTC.address);

            const initialBalances = await this.displayWalletOverview();
            if (!initialBalances) {
                await this.log(`Không thể lấy số dư ví`, 'error');
                return;
            }

            const minPHRSForOperations = ethers.parseEther("0.2");
            if (initialBalances.nativePhrs < minPHRSForOperations) {
                await this.log(`Số dư PHRS không đủ để thực hiện. Cần: ${ethers.formatEther(minPHRSForOperations)}, Hiện có: ${ethers.formatEther(initialBalances.nativePhrs)}`, 'error');
                return;
            }

            await this.log(`Thực hiện ${SWAP_CYCLES} lần swap cho cặp PHRS-USDC và PHRS-USDT`, 'info');
            await this.performSwaps();

            let successCount = 0;
            const totalLiquidityAdditions = LIQUIDITY_POOLS.length * 5; // 10 lần thêm thanh khoản

            for (const poolConfig of LIQUIDITY_POOLS) {
                await this.log(`Bắt đầu thêm thanh khoản 5 lần cho ${poolConfig.name}`, 'info');
                for (let i = 1; i <= 5; i++) {
                    await this.log(`Lần thêm thanh khoản ${i}/5 cho ${poolConfig.name}`, 'info');
                    const result = await this.processLiquidityAddition(poolConfig);
                    if (result) {
                        successCount++;
                        await this.log(`Lần ${i}/5 cho ${poolConfig.name}: THÀNH CÔNG`, 'success');
                    } else {
                        await this.log(`Lần ${i}/5 cho ${poolConfig.name}: THẤT BẠI`, 'error');
                    }
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }

            await this.log(`Tóm tắt ví: Thành công: ${successCount}/${totalLiquidityAdditions}, Thất bại: ${totalLiquidityAdditions - successCount}/${totalLiquidityAdditions}`, 'info');
            await this.displayWalletOverview();

            await this.log(`Bắt đầu swap 98% số dư token còn lại về PHRS`, 'info');
            const tokensToSwap = [
                { address: TOKENS.USDC.address, decimals: TOKENS.USDC.decimals, name: "USDC" },
                { address: TOKENS.USDT.address, decimals: TOKENS.USDT.decimals, name: "USDT" },
                { address: TOKENS.WPHRS.address, decimals: TOKENS.WPHRS.decimals, name: "WPHRS" },
                { address: TOKENS.WBTC.address, decimals: TOKENS.WBTC.decimals, name: "WBTC" }
            ];

            for (const token of tokensToSwap) {
                await this.log(`Đang swap 98% ${token.name} về PHRS`, 'info');
                const swapSuccess = await this.swapTokensToPHRS(token.address, token.decimals);
                if (swapSuccess) {
                    await this.log(`Swap 98% ${token.name} về PHRS thành công`, 'success');
                } else {
                    await this.log(`Swap 98% ${token.name} về PHRS thất bại`, 'error');
                }
                await new Promise(resolve => setTimeout(resolve, 3000));
            }

            await this.log(`Hoàn tất swap token về PHRS`, 'info');
            await this.displayWalletOverview();
        } catch (error) {
            await this.log(`Lỗi: ${error.message}`, 'error');
        }
    }
}


if (isMainThread) {
    async function main() {
        const walletData = fs.readFileSync('privateKeys.txt', 'utf8');
        const privateKeys = walletData.split('\n').filter(key => key.trim() !== '');
        console.log(`Đã tải ${privateKeys.length} ví`.blue);

        for (let i = 0; i < privateKeys.length; i += maxThreads) {
            const currentBatch = privateKeys.slice(i, i + maxThreads);
            const workers = [];
            console.log(`Đang xử lý lô ${Math.floor(i / maxThreads) + 1} với ${currentBatch.length} ví`.blue);

            for (let j = 0; j < currentBatch.length; j++) {
                const worker = new Worker(__filename, {
                    workerData: {
                        accountIndex: i + j,
                        privateKey: currentBatch[j].trim(),
                        proxyIP: null
                    }
                });

                const timeout = setTimeout(() => {
                    worker.terminate();
                    console.log(`[Tài khoản ${i + j + 1}] Luồng đã hết thời gian sau 30 phút`.red);
                }, THREAD_TIMEOUT);

                worker.on('message', (msg) => console.log(msg));
                worker.on('error', (err) => console.log(`[Tài khoản ${i + j + 1}] Lỗi luồng: ${err.message}`.red));
                worker.on('exit', (code) => {
                    clearTimeout(timeout);
                    console.log(`[Tài khoản ${i + j + 1}] Luồng đã thoát với mã ${code}`.blue);
                });

                workers.push(worker);
            }

            await Promise.all(workers.map(worker => new Promise(resolve => worker.once('exit', resolve))));
            console.log(`Lô ${Math.floor(i / maxThreads) + 1} hoàn tất`.blue);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        console.log('🎉 TẤT CẢ HOẠT ĐỘNG ĐÃ HOÀN TẤT!'.blue);
    }

    main().catch(err => console.error('Lỗi rồi:'.red, err));
} else {
    const bot = new DODOSwapBot(workerData.accountIndex, workerData.privateKey, workerData.proxyIP);
    bot.runWorker().then(() => parentPort.postMessage('Hoàn thành')).catch(err => parentPort.postMessage(`Lỗi worker: ${err.message}`));
}

process.on('SIGINT', () => {
    console.log('🛑 Bot đã dừng lại'.red);
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:'.red, error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:'.red, promise, 'reason:', reason);
    process.exit(1);
});