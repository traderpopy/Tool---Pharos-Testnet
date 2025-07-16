
const ethers = require('ethers');
const axios = require('axios');
const fs = require('fs').promises;
const { HttpsProxyAgent } = require('https-proxy-agent');
const colors = require('colors');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');

colors.enable();

const TIMEOUT_MS = 600000;
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 15000;
const MAX_THREADS = 10;
const SEND_TO_FRIENDS = 10;

const networkConfig = {
    name: "Pharos Testnet",
    chainId: 688688,
    rpcUrl: "https://testnet.dplabs-internal.com",
};

class TimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TimeoutError';
    }
}

function withTimeout(promise, timeoutMs = TIMEOUT_MS, errorMessage = 'Operation timed out') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new TimeoutError(errorMessage)), timeoutMs)
        )
    ]);
}

async function log(msg, type = 'info', accountIndex = 0, proxyIP = 'Unknown IP') {
    const timestamp = new Date().toLocaleTimeString();
    const accountPrefix = `[Tài khoản ${accountIndex + 1}]`;
    const ipPrefix = proxyIP ? `[${proxyIP}]` : '[Unknown IP]';
    let logMessage = '';

    switch (type) {
        case 'success':
            logMessage = `${accountPrefix}${ipPrefix} ${msg}`.green;
            break;
        case 'error':
            logMessage = `${accountPrefix}${ipPrefix} ${msg}`.red;
            break;
        case 'warning':
            logMessage = `${accountPrefix}${ipPrefix} ${msg}`.yellow;
            break;
        default:
            logMessage = `${accountPrefix}${ipPrefix} ${msg}`.blue;
    }

    console.log(logMessage);
}

async function checkProxyIP(proxy, accountIndex) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const proxyAgent = new HttpsProxyAgent(proxy);
            const response = await withTimeout(
                axios.get('https://api.ipify.org?format=json', { httpsAgent: proxyAgent }),
                TIMEOUT_MS,
                `Proxy IP check timed out for ${proxy}`
            );
            if (response.status === 200) {
                return response.data.ip;
            }
            throw new Error(`Invalid proxy response. Status code: ${response.status}`);
        } catch (error) {
            await log(`Thử lần ${attempt}/${MAX_RETRIES} thất bại khi kiểm tra proxy ${proxy}: ${error.message}`, 'error', accountIndex);
            if ((error instanceof TimeoutError || error.code === 'ECONNABORTED' || error.code === -32008) && attempt < MAX_RETRIES) {
                await log(`Timeout hoặc lỗi mạng, thử lại sau ${RETRY_DELAY_MS / 1000} giây...`, 'warning', accountIndex);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                continue;
            }
            throw error;
        }
    }
    throw new Error(`Không thể kiểm tra IP của proxy ${proxy} sau ${MAX_RETRIES} lần thử`);
}

async function readInputFiles() {
    try {
        const privateKeys = (await withTimeout(
            fs.readFile('privateKeys.txt', 'utf8'),
            TIMEOUT_MS,
            'Reading privateKeys.txt timed out'
        )).split('\n').map(key => key.trim()).filter(key => key)
            .map(key => key.startsWith('0x') ? key : '0x' + key)
            .filter(key => key.length === 66);

        const proxies = (await withTimeout(
            fs.readFile('proxy.txt', 'utf8'),
            TIMEOUT_MS,
            'Reading proxy.txt timed out'
        )).split('\n').map(proxy => proxy.trim()).filter(proxy => proxy);

        const userAgents = (await withTimeout(
            fs.readFile('agent.txt', 'utf8'),
            TIMEOUT_MS,
            'Reading agent.txt timed out'
        )).split('\n').map(agent => agent.trim()).filter(agent => agent);

        return { privateKeys, proxies, userAgents };
    } catch (error) {
        await log(`Error reading input files: ${error.message}`, 'error', 0);
        throw error;
    }
}

async function getWalletsAndSignatures(privateKeys) {
    try {
        const wallets = privateKeys.map(privateKey => {
            const wallet = new ethers.Wallet(privateKey);
            return { wallet, privateKey };
        });
        const signatures = await Promise.all(
            wallets.map(async ({ wallet }) => {
                const message = "pharos";
                return await withTimeout(
                    wallet.signMessage(message),
                    TIMEOUT_MS,
                    `Signing message for wallet timed out`
                );
            })
        );
        return wallets.map(({ wallet, privateKey }, index) => ({
            address: wallet.address,
            privateKey,
            signature: signatures[index]
        }));
    } catch (error) {
        await log(`Error creating wallets or signatures: ${error.message}`, 'error', 0);
        throw error;
    }
}

async function login(address, signature, inviteCode, proxy, userAgent, accountIndex, proxyIP) {
    const url = `https://api.pharosnetwork.xyz/user/login?address=${address}&signature=${signature}&invite_code=${inviteCode}`;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const proxyAgent = new HttpsProxyAgent(proxy);
            const response = await withTimeout(
                axios.post(url, {}, {
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Authorization': 'Bearer null',
                        'Origin': 'https://testnet.pharosnetwork.xyz',
                        'Referer': 'https://testnet.pharosnetwork.xyz/',
                        'User-Agent': userAgent
                    },
                    httpsAgent: proxyAgent
                }),
                TIMEOUT_MS,
                `Login API timed out for ${address}`
            );
            return response.data;
        } catch (error) {
            await log(`Thử lần ${attempt}/${MAX_RETRIES} thất bại khi đăng nhập ví ${address}: ${error.response?.data?.message || error.message}`, 'error', accountIndex, proxyIP);
            if ((error instanceof TimeoutError || error.code === 'ECONNABORTED' || error.code === -32008) && attempt < MAX_RETRIES) {
                await log(`Timeout hoặc lỗi mạng, thử lại sau ${RETRY_DELAY_MS / 1000} giây...`, 'warning', accountIndex, proxyIP);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                continue;
            }
            throw error;
        }
    }
    throw new Error(`Không thể đăng nhập ví ${address} sau ${MAX_RETRIES} lần thử`);
}

async function getSignStatus(address, jwt, proxy, userAgent, accountIndex, proxyIP) {
    const url = `https://api.pharosnetwork.xyz/sign/status?address=${address}`;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const proxyAgent = new HttpsProxyAgent(proxy);
            const response = await withTimeout(
                axios.get(url, {
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Authorization': `Bearer ${jwt}`,
                        'Origin': 'https://testnet.pharosnetwork.xyz',
                        'Referer': 'https://testnet.pharosnetwork.xyz/',
                        'User-Agent': userAgent
                    },
                    httpsAgent: proxyAgent
                }),
                TIMEOUT_MS,
                `Sign status API timed out for ${address}`
            );
            return response.data;
        } catch (error) {
            await log(`Thử lần ${attempt}/${MAX_RETRIES} thất bại khi lấy trạng thái điểm danh ví ${address}: ${error.response?.data?.message || error.message}`, 'error', accountIndex, proxyIP);
            if ((error instanceof TimeoutError || error.code === 'ECONNABORTED' || error.code === -32008) && attempt < MAX_RETRIES) {
                await log(`Timeout hoặc lỗi mạng, thử lại sau ${RETRY_DELAY_MS / 1000} giây...`, 'warning', accountIndex, proxyIP);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                continue;
            }
            throw error;
        }
    }
    throw new Error(`Không thể lấy trạng thái điểm danh ví ${address} sau ${MAX_RETRIES} lần thử`);
}

async function getUserProfile(address, jwt, proxy, userAgent, accountIndex, proxyIP) {
    const url = `https://api.pharosnetwork.xyz/user/profile?address=${address}`;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const proxyAgent = new HttpsProxyAgent(proxy);
            const response = await withTimeout(
                axios.get(url, {
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Authorization': `Bearer ${jwt}`,
                        'Origin': 'https://testnet.pharosnetwork.xyz',
                        'Referer': 'https://testnet.pharosnetwork.xyz/',
                        'User-Agent': userAgent
                    },
                    httpsAgent: proxyAgent
                }),
                TIMEOUT_MS,
                `User profile API timed out for ${address}`
            );
            return response.data;
        } catch (error) {
            await log(`Thử lần ${attempt}/${MAX_RETRIES} thất bại khi lấy hồ sơ ví ${address}: ${error.response?.data?.message || error.message}`, 'error', accountIndex, proxyIP);
            if ((error instanceof TimeoutError || error.code === 'ECONNABORTED' || error.code === -32008) && attempt < MAX_RETRIES) {
                await log(`Timeout hoặc lỗi mạng, thử lại sau ${RETRY_DELAY_MS / 1000} giây...`, 'warning', accountIndex, proxyIP);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                continue;
            }
            throw error;
        }
    }
    throw new Error(`Không thể lấy hồ sơ ví ${address} sau ${MAX_RETRIES} lần thử`);
}

async function performSignIn(address, jwt, proxy, userAgent, accountIndex, proxyIP) {
    const url = `https://api.pharosnetwork.xyz/sign/in?address=${address}`;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const proxyAgent = new HttpsProxyAgent(proxy);
            const response = await withTimeout(
                axios.post(url, {}, {
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Authorization': `Bearer ${jwt}`,
                        'Origin': 'https://testnet.pharosnetwork.xyz',
                        'Referer': 'https://testnet.pharosnetwork.xyz/',
                        'User-Agent': userAgent
                    },
                    httpsAgent: proxyAgent
                }),
                TIMEOUT_MS,
                `Sign-in API timed out for ${address}`
            );
            return response.data;
        } catch (error) {
            await log(`Thử lần ${attempt}/${MAX_RETRIES} thất bại khi điểm danh ví ${address}: ${error.response?.data?.message || error.message}`, 'error', accountIndex, proxyIP);
            if ((error instanceof TimeoutError || error.code === 'ECONNABORTED' || error.code === -32008) && attempt < MAX_RETRIES) {
                await log(`Timeout hoặc lỗi mạng, thử lại sau ${RETRY_DELAY_MS / 1000} giây...`, 'warning', accountIndex, proxyIP);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                continue;
            }
            throw error;
        }
    }
    throw new Error(`Không thể điểm danh ví ${address} sau ${MAX_RETRIES} lần thử`);
}

async function performDailyFaucet(address, jwt, proxy, userAgent, accountIndex, proxyIP) {
    const url = `https://api.pharosnetwork.xyz/faucet/daily?address=${address}`;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const proxyAgent = new HttpsProxyAgent(proxy);
            const response = await withTimeout(
                axios.post(url, {}, {
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Authorization': `Bearer ${jwt}`,
                        'Origin': 'https://testnet.pharosnetwork.xyz',
                        'Referer': 'https://testnet.pharosnetwork.xyz/',
                        'User-Agent': userAgent
                    },
                    httpsAgent: proxyAgent
                }),
                TIMEOUT_MS,
                `Daily faucet API timed out for ${address}`
            );
            return response.data;
        } catch (error) {
            await log(`Thử lần ${attempt}/${MAX_RETRIES} thất bại khi yêu cầu faucet ví ${address}: ${error.response?.data?.message || error.message}`, 'error', accountIndex, proxyIP);
            if ((error instanceof TimeoutError || error.code === 'ECONNABORTED' || error.code === -32008) && attempt < MAX_RETRIES) {
                await log(`Timeout hoặc lỗi mạng, thử lại sau ${RETRY_DELAY_MS / 1000} giây...`, 'warning', accountIndex, proxyIP);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                continue;
            }
            throw error;
        }
    }
    throw new Error(`Không thể yêu cầu faucet ví ${address} sau ${MAX_RETRIES} lần thử`);
}

async function checkFaucetStatus(address, jwt, proxy, userAgent, accountIndex, proxyIP) {
    const url = `https://api.pharosnetwork.xyz/faucet/status?address=${address}`;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const proxyAgent = new HttpsProxyAgent(proxy);
            const response = await withTimeout(
                axios.get(url, {
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Authorization': `Bearer ${jwt}`,
                        'Origin': 'https://testnet.pharosnetwork.xyz',
                        'Referer': 'https://testnet.pharosnetwork.xyz/',
                        'User-Agent': userAgent
                    },
                    httpsAgent: proxyAgent
                }),
                TIMEOUT_MS,
                `Faucet status API timed out for ${address}`
            );
            return response.data;
        } catch (error) {
            await log(`Thử lần ${attempt}/${MAX_RETRIES} thất bại khi kiểm tra faucet ví ${address}: ${error.response?.data?.message || error.message}`, 'error', accountIndex, proxyIP);
            if ((error instanceof TimeoutError || error.code === 'ECONNABORTED' || error.code === -32008) && attempt < MAX_RETRIES) {
                await log(`Timeout hoặc lỗi mạng, thử lại sau ${RETRY_DELAY_MS / 1000} giây...`, 'warning', accountIndex, proxyIP);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                continue;
            }
            throw error;
        }
    }
    throw new Error(`Không thể kiểm tra faucet ví ${address} sau ${MAX_RETRIES} lần thử`);
}

function generateRandomEVMAddress() {
    const randomBytes = crypto.randomBytes(20);
    return '0x' + randomBytes.toString('hex');
}


async function sendToFriend(wallet, toAddress, amount, provider, accountIndex, proxyIP) {
    try {
        const feeData = await provider.getFeeData();
        
        const tx = {
            to: toAddress,
            value: ethers.parseEther(amount.toString()),
            gasLimit: 21000,
            gasPrice: feeData.gasPrice,
            chainId: networkConfig.chainId,
            type: 0 
        };
        
        const txResponse = await wallet.sendTransaction(tx);
        
        const receipt = await withTimeout(
            txResponse.wait(),
            TIMEOUT_MS,
            `Transaction confirmation timed out for ${toAddress}`
        );
        
        return receipt.hash;
    } catch (error) {
        await log(`Lỗi khi gửi PHRS đến ${toAddress}: ${error.message}`, 'error', accountIndex, proxyIP);
        throw error;
    }
}

async function verifySendToFriend(address, txHash, jwt, proxy, userAgent, accountIndex, proxyIP) {
    const url = `https://api.pharosnetwork.xyz/task/verify`;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const proxyAgent = new HttpsProxyAgent(proxy);
            const response = await withTimeout(
                axios.post(url, {
                    address,
                    task_id: 103,
                    tx_hash: txHash
                }, {
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Authorization': `Bearer ${jwt}`,
                        'Origin': 'https://testnet.pharosnetwork.xyz',
                        'Referer': 'https://testnet.pharosnetwork.xyz/',
                        'User-Agent': userAgent,
                        'Content-Type': 'application/json'
                    },
                    httpsAgent: proxyAgent
                }),
                TIMEOUT_MS,
                `Task verification API timed out for ${address}`
            );
            return response.data;
        } catch (error) {
            await log(`Thử lần ${attempt}/${MAX_RETRIES} thất bại khi xác minh gửi PHRS cho bạn bè ví ${address}: ${error.response?.data?.message || error.message}`, 'error', accountIndex, proxyIP);
            if ((error instanceof TimeoutError || error.code === 'ECONNABORTED' || error.code === -32008) && attempt < MAX_RETRIES) {
                await log(`Timeout hoặc lỗi mạng, thử lại sau ${RETRY_DELAY_MS / 1000} giây...`, 'warning', accountIndex, proxyIP);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                continue;
            }
            throw error;
        }
    }
    throw new Error(`Không thể xác minh gửi PHRS cho bạn bè ví ${address} sau ${MAX_RETRIES} lần thử`);
}

async function processAccount({ walletData, proxy, userAgent, accountIndex, inviteCode }) {
    const { address, privateKey, signature } = walletData;
    let proxyIP = 'Unknown IP';
    try {
        proxyIP = await checkProxyIP(proxy, accountIndex);
        await log(`Đang sử dụng proxy với IP: ${proxyIP}`, 'info', accountIndex, proxyIP);
        const loginResponse = await login(address, signature, inviteCode, proxy, userAgent, accountIndex, proxyIP);
        await log(`Đăng nhập thành công`, 'success', accountIndex, proxyIP);
        const jwt = loginResponse.data.jwt;

        const profileResponse = await getUserProfile(address, jwt, proxy, userAgent, accountIndex, proxyIP);
        await log(`Tổng điểm: ${profileResponse.data.user_info.TotalPoints}`, 'info', accountIndex, proxyIP);
        await log(`InviteCode: ${profileResponse.data.user_info.InviteCode}`, 'info', accountIndex, proxyIP);

        const statusResponse = await getSignStatus(address, jwt, proxy, userAgent, accountIndex, proxyIP);
        let signInSuccess = false;
        if (statusResponse.data && statusResponse.data.status !== 'signed') {
            const signInResponse = await performSignIn(address, jwt, proxy, userAgent, accountIndex, proxyIP);
            if (signInResponse.code === 0) {
                signInSuccess = true;
                await log(`Điểm danh hàng ngày thành công!`, 'success', accountIndex, proxyIP);
            } else {
                await log(`Điểm danh thất bại: ${signInResponse.msg}`, 'error', accountIndex, proxyIP);
            }
        } else {
            await log(`Đã điểm danh hôm nay hoặc trạng thái: ${statusResponse.data?.status || 'unknown'}`, 'warning', accountIndex, proxyIP);
        }

        const faucetStatusResponse = await checkFaucetStatus(address, jwt, proxy, userAgent, accountIndex, proxyIP);
        let pharosFaucetSuccess = false;
        if (faucetStatusResponse.data.is_able_to_faucet === true) {
            const faucetResponse = await performDailyFaucet(address, jwt, proxy, userAgent, accountIndex, proxyIP);
            if (faucetResponse.code === 0) {
                pharosFaucetSuccess = true;
                await log(`Yêu cầu faucet PHRS thành công!`, 'success', accountIndex, proxyIP);
            } else {
                await log(`Yêu cầu faucet PHRS thất bại: ${faucetResponse.msg}`, 'error', accountIndex, proxyIP);
            }
        } else {
            await log(`Hôm nay bạn đã yêu cầu PHRS rồi.`, 'warning', accountIndex, proxyIP);
        }

        let sendToFriendSuccessCount = 0;
        if (SEND_TO_FRIENDS > 0) {
            await log(`Bắt đầu gửi 0.001 PHRS đến ${SEND_TO_FRIENDS} địa chỉ bạn bè`, 'info', accountIndex, proxyIP);
            const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl, {
                chainId: networkConfig.chainId,
                name: networkConfig.name
            });
            const wallet = new ethers.Wallet(privateKey, provider);
            const usedAddresses = new Set([address]);

            for (let i = 0; i < SEND_TO_FRIENDS; i++) {
                let toAddress;
                do {
                    toAddress = generateRandomEVMAddress();
                } while (usedAddresses.has(toAddress));
                usedAddresses.add(toAddress);

                try {
                    const txHash = await sendToFriend(wallet, toAddress, 0.001, provider, accountIndex, proxyIP);
                    await log(`Gửi 0.001 PHRS đến ${toAddress} thành công, txHash: ${txHash}`, 'success', accountIndex, proxyIP);
                    const verifyResponse = await verifySendToFriend(address, txHash, jwt, proxy, userAgent, accountIndex, proxyIP);
                    if (verifyResponse.code === 0 && verifyResponse.data.verified) {
                        await log(`Xác minh gửi PHRS cho bạn bè thành công`, 'success', accountIndex, proxyIP);
                        sendToFriendSuccessCount++;
                    } else {
                        await log(`Xác minh gửi PHRS cho bạn bè thất bại: ${verifyResponse.msg}`, 'error', accountIndex, proxyIP);
                    }
                } catch (error) {
                    await log(`Lỗi khi gửi hoặc xác minh PHRS đến ${toAddress}: ${error.message}`, 'error', accountIndex, proxyIP);
                }
            }
        }

        return { signInSuccess, pharosFaucetSuccess, sendToFriendSuccessCount };
    } catch (error) {
        await log(`Lỗi khi xử lý ví ${address}: ${error.message}`, 'error', accountIndex, proxyIP);
        return { signInSuccess: false, pharosFaucetSuccess: false, sendToFriendSuccessCount: 0 };
    }
}

if (isMainThread) {
    (async () => {
        const inviteCode = 'ejvfRPamMvwbHcqx';
        try {
            await log('Dân cày airdrop...', 'info', 0);
            const { privateKeys, proxies, userAgents } = await readInputFiles();
            if (privateKeys.length === 0) {
                await log('Không tìm thấy private key nào trong privateKeys.txt', 'error', 0);
                return;
            }
            if (proxies.length === 0) {
                await log('Không tìm thấy proxy hợp lệ nào trong proxy.txt', 'error', 0);
                return;
            }
            if (userAgents.length === 0) {
                await log('Không tìm thấy User-Agent nào trong agent.txt', 'error', 0);
                return;
            }
            if (privateKeys.length !== proxies.length) {
                await log(`Lỗi: Số lượng private key (${privateKeys.length}) không bằng số lượng proxy (${proxies.length})`, 'error', 0);
                return;
            }
            const uniqueProxies = new Set(proxies);
            if (uniqueProxies.size !== proxies.length) {
                await log(`Lỗi: Phát hiện có proxy trùng lặp trong file proxy.txt`, 'error', 0);
                return;
            }
            await log(`Đọc được ${privateKeys.length} ví, ${proxies.length} proxy, và ${userAgents.length} User-Agent`, 'success', 0);
            const walletData = await getWalletsAndSignatures(privateKeys);

            let signInSuccessCount = 0;
            let pharosFaucetSuccessCount = 0;
            let sendToFriendSuccessTotal = 0;
            let currentIndex = 0;
            const results = [];

            const runWorker = (index) => {
                return new Promise((resolve) => {
                    const worker = new Worker(__filename, {
                        workerData: {
                            walletData: walletData[index],
                            proxy: proxies[index],
                            userAgent: index < userAgents.length ? userAgents[index] : userAgents[index % userAgents.length],
                            accountIndex: index,
                            inviteCode
                        }
                    });
                    worker.on('message', (result) => {
                        results[index] = result;
                        resolve();
                    });
                    worker.on('error', async (error) => {
                        await log(`Worker error for account ${index + 1}: ${error.message}`, 'error', index);
                        results[index] = { signInSuccess: false, pharosFaucetSuccess: false, sendToFriendSuccessCount: 0 };
                        resolve();
                    });
                    worker.on('exit', (code) => {
                        if (code !== 0) {
                            log(`Worker exited with code ${code} for account ${index + 1}`, 'error', index);
                        }
                    });
                });
            };

            while (currentIndex < walletData.length) {
                const activeWorkers = [];
                for (let i = 0; i < MAX_THREADS && currentIndex < walletData.length; i++, currentIndex++) {
                    await log(`Xử lý ví ${currentIndex + 1}/${walletData.length}: ${walletData[currentIndex].address}`, 'info', currentIndex);
                    activeWorkers.push(runWorker(currentIndex));
                }
                await Promise.all(activeWorkers);
            }

            signInSuccessCount = results.filter(r => r.signInSuccess).length;
            pharosFaucetSuccessCount = results.filter(r => r.pharosFaucetSuccess).length;
            sendToFriendSuccessTotal = results.reduce((sum, r) => sum + r.sendToFriendSuccessCount, 0);

            await log(`==== Đã xử lý tất cả ví ====`, 'info', 0);
            await log(`Điểm danh hàng ngày: Thành công: ${signInSuccessCount}/${walletData.length}`, 'info', 0);
            await log(`Faucet Pharos: Thành công: ${pharosFaucetSuccessCount}/${walletData.length}`, 'info', 0);
            await log(`Gửi PHRS cho bạn bè: Thành công: ${sendToFriendSuccessTotal}/${walletData.length * SEND_TO_FRIENDS}`, 'info', 0);
            await log('Xong :)))', 'success', 0);
        } catch (error) {
            await log(`Main function error: ${error.message}`, 'error', 0);
        }
    })();
} else {
    (async () => {
        const result = await processAccount(workerData);
        parentPort.postMessage(result);
    })();
}