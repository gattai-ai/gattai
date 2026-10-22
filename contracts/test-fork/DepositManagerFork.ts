import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseEther,
  parseEventLogs,
  parseUnits,
  toHex,
  zeroAddress,
} from "viem";

/**
 * Fork test mainnet: DepositManager + Safe asli + USDG asli.
 *
 * Jalankan:
 *   bun run --cwd contracts test:fork
 *
 * Env opsional:
 *   FORK_BLOCK_NUMBER   pin block fork; hanya jika RPC yang dipakai archive
 *   FORK_USDG_HOLDER    alamat holder USDG yang akan di-impersonate
 *
 * Test ini tidak mengirim transaksi ke mainnet; semua terjadi di fork EDR.
 */

const SAFE_FACTORY = "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2" as const;
const SAFE_SINGLETON = "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552" as const;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const USDG_HOLDER = (process.env.FORK_USDG_HOLDER ??
  "0x9f736f87e6293ac1bd9142e257dbfac8b7acf1ae") as `0x${string}`;

const PROJECT_ID = keccak256(toHex("fork-deposit-demo"));
const USDG_CAP = parseUnits("1000", 6);
const DEPOSIT_AMOUNT = parseUnits("10", 6);

const SAFE_ABI = parseAbi([
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function approveHash(bytes32 hashToApprove)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool success)",
]);
const SAFE_FACTORY_ABI = parseAbi([
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "event ProxyCreation(address proxy, address singleton)",
]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

describe("DepositManager fork mainnet (Safe + USDG asli)", async function () {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();
  const [deployer, owner2, owner3] = await viem.getWalletClients();

  it("membuat Safe 2-of-3, deploy DM, lalu deposit USDG asli", async function () {
    const chainId = await publicClient.getChainId();
    assert.equal(chainId, 4663, "jalankan dengan --network robinhoodFork");

    const forkBlock = await publicClient.getBlockNumber();
    console.log(`[fork] chain ${chainId}, block ${forkBlock}`);

    // Akun lokal butuh gas untuk deploy DM, membuat Safe, dan approve hash.
    for (const wallet of [deployer, owner2, owner3]) {
      await testClient.setBalance({
        address: wallet.account.address,
        value: parseEther("100"),
      });
    }

    // 1. Buat Safe 2-of-3 lewat SafeProxyFactory kanonik di fork.
    const owners = [
      deployer.account.address,
      owner2.account.address,
      owner3.account.address,
    ];
    const initializer = encodeFunctionData({
      abi: SAFE_ABI,
      functionName: "setup",
      args: [owners, 2n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress],
    });
    const safeTxHash = await deployer.writeContract({
      address: SAFE_FACTORY,
      abi: SAFE_FACTORY_ABI,
      functionName: "createProxyWithNonce",
      args: [SAFE_SINGLETON, initializer, 12345n],
    });
    const safeReceipt = await publicClient.waitForTransactionReceipt({ hash: safeTxHash });
    const [proxyCreated] = parseEventLogs({
      abi: SAFE_FACTORY_ABI,
      eventName: "ProxyCreation",
      logs: safeReceipt.logs,
    });
    assert.ok(proxyCreated, "event ProxyCreation tidak ditemukan");
    const safeAddress = proxyCreated.args.proxy;

    const safeOwners = await publicClient.readContract({
      address: safeAddress,
      abi: SAFE_ABI,
      functionName: "getOwners",
    });
    const safeThreshold = await publicClient.readContract({
      address: safeAddress,
      abi: SAFE_ABI,
      functionName: "getThreshold",
    });
    assert.deepEqual(
      safeOwners.map((owner) => owner.toLowerCase()),
      owners.map((owner) => owner.toLowerCase()),
    );
    assert.equal(safeThreshold, 2n);
    console.log(`[fork] Safe 2-of-3: ${safeAddress}`);

    const walletByOwner = new Map([
      [deployer.account.address.toLowerCase(), deployer],
      [owner2.account.address.toLowerCase(), owner2],
      [owner3.account.address.toLowerCase(), owner3],
    ]);

    // Eksekusi transaksi Safe memakai approved hash (v=1), tanpa perlu
    // menandatangani pesan EIP-712 di luar. Ini menguji jalur Safe asli.
    const execSafe = async (to: `0x${string}`, data: `0x${string}`) => {
      const nonce = await publicClient.readContract({
        address: safeAddress,
        abi: SAFE_ABI,
        functionName: "nonce",
      });
      const safeTxHash = await publicClient.readContract({
        address: safeAddress,
        abi: SAFE_ABI,
        functionName: "getTransactionHash",
        args: [to, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce],
      });
      const signers = [...owners]
        .map((owner) => owner.toLowerCase())
        .sort()
        .slice(0, 2);
      for (const signer of signers) {
        const signerWallet = walletByOwner.get(signer);
        assert.ok(signerWallet, `wallet untuk owner ${signer} tidak ditemukan`);
        await signerWallet.writeContract({
          address: safeAddress,
          abi: SAFE_ABI,
          functionName: "approveHash",
          args: [safeTxHash],
        });
      }
      const signatures = `0x${signers
        .map((signer) => `${signer.slice(2).padStart(64, "0")}${"0".repeat(64)}01`)
        .join("")}` as `0x${string}`;
      await deployer.writeContract({
        address: safeAddress,
        abi: SAFE_ABI,
        functionName: "execTransaction",
        args: [
          to,
          0n,
          data,
          0,
          0n,
          0n,
          0n,
          zeroAddress,
          zeroAddress,
          signatures,
        ],
      });
    };

    // 2. Deploy DepositManager dengan Safe sebagai treasury, lalu konfigurasi
    //    Fase 1 sebelum ownership diserahkan ke Safe.
    const dm = await viem.deployContract("DepositManager", [safeAddress]);
    await dm.write.setNativeAccepted([false]);
    await dm.write.setTokenAccepted([USDG, true]);
    await dm.write.setMaxAmount([USDG, USDG_CAP]);

    assert.equal(
      (await dm.read.owner()).toLowerCase(),
      deployer.account.address.toLowerCase(),
    );
    assert.equal((await dm.read.treasury()).toLowerCase(), safeAddress.toLowerCase());
    assert.equal(await dm.read.nativeAccepted(), false);
    assert.equal(await dm.read.acceptedToken([USDG]), true);
    assert.equal(await dm.read.maxAmount([USDG]), USDG_CAP);

    // Ownership hanya boleh pindah ke treasury dan tidak boleh di-renounce.
    await assert.rejects(
      dm.write.transferOwnership([owner2.account.address]),
      /OwnerMustBeTreasury/,
    );
    await assert.rejects(dm.read.renounceOwnership(), /RenounceOwnershipDisabled/);

    // Pause menghentikan deposit; unpause mengaktifkan kembali.
    await dm.write.pause();
    assert.equal(await dm.read.paused(), true);
    await assert.rejects(
      dm.write.deposit([PROJECT_ID, USDG, 1n]),
      /EnforcedPause|paused/i,
    );
    await dm.write.unpause();
    assert.equal(await dm.read.paused(), false);

    // Token yang belum di-allowlist harus ditolak sebelum ada transfer.
    await assert.rejects(
      dm.write.deposit([PROJECT_ID, SAFE_FACTORY, 1n]),
      /TokenNotAccepted/,
    );

    console.log(`[fork] DepositManager: ${dm.address}`);

    // 3. Impersonate holder USDG asli, beri gas, lalu deposit lewat kontrak.
    await testClient.impersonateAccount({ address: USDG_HOLDER });
    await testClient.setBalance({ address: USDG_HOLDER, value: parseEther("10") });
    const holderWallet = await viem.getWalletClient(USDG_HOLDER);

    const holderBalance = await publicClient.readContract({
      address: USDG,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [USDG_HOLDER],
    });
    assert.ok(
      holderBalance >= DEPOSIT_AMOUNT,
      `saldo USDG holder ${USDG_HOLDER} kurang: ${holderBalance}`,
    );

    await holderWallet.writeContract({
      address: USDG,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [dm.address, parseUnits("2000", 6)],
    });

    const treasuryBefore = await publicClient.readContract({
      address: USDG,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [safeAddress],
    });
    const depositHash = await holderWallet.writeContract({
      address: dm.address,
      abi: dm.abi,
      functionName: "deposit",
      args: [PROJECT_ID, USDG, DEPOSIT_AMOUNT],
    });
    const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
    const treasuryAfter = await publicClient.readContract({
      address: USDG,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [safeAddress],
    });
    assert.equal(treasuryAfter - treasuryBefore, DEPOSIT_AMOUNT);

    const contractUsdg = await publicClient.readContract({
      address: USDG,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [dm.address],
    });
    assert.equal(contractUsdg, 0n, "DepositManager tidak boleh menyimpan USDG");

    const [deposited] = parseEventLogs({
      abi: dm.abi,
      eventName: "Deposited",
      logs: depositReceipt.logs,
    });
    assert.ok(deposited, "event Deposited tidak ditemukan");
    assert.equal(deposited.args.projectId, PROJECT_ID);
    assert.equal(deposited.args.payer.toLowerCase(), USDG_HOLDER.toLowerCase());
    assert.equal(deposited.args.token.toLowerCase(), USDG.toLowerCase());
    assert.equal(deposited.args.amount, DEPOSIT_AMOUNT);
    console.log(`[fork] deposit ${DEPOSIT_AMOUNT.toString()} USDG raw sukses`);

    // 4. Cap harus menolak deposit di atas batas sebelum dana berpindah.
    await assert.rejects(
      holderWallet.writeContract({
        address: dm.address,
        abi: dm.abi,
        functionName: "deposit",
        args: [PROJECT_ID, USDG, USDG_CAP + 1n],
      }),
      /AmountAboveMax|revert/i,
    );

    // 4b. Rescue token: kirim USDG langsung ke kontrak, lalu selamatkan.
    const rescueAmount = parseUnits("1", 6);
    await holderWallet.writeContract({
      address: USDG,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [dm.address, rescueAmount],
    });
    assert.equal(
      await publicClient.readContract({
        address: USDG,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [dm.address],
      }),
      rescueAmount,
    );
    const safeRescueBefore = await publicClient.readContract({
      address: USDG,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [safeAddress],
    });
    await dm.write.rescueToken([USDG, safeAddress, rescueAmount]);
    const safeRescueAfter = await publicClient.readContract({
      address: USDG,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [safeAddress],
    });
    assert.equal(safeRescueAfter - safeRescueBefore, rescueAmount);
    assert.equal(
      await publicClient.readContract({
        address: USDG,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [dm.address],
      }),
      0n,
    );

    // 4c. Rescue native: paksa ETH masuk lewat setBalance, lalu selamatkan.
    await testClient.setBalance({ address: dm.address, value: parseEther("2") });
    const safeEthBefore = await publicClient.getBalance({ address: safeAddress });
    await dm.write.rescueNative([safeAddress, parseEther("1")]);
    const safeEthAfter = await publicClient.getBalance({ address: safeAddress });
    assert.equal(safeEthAfter - safeEthBefore, parseEther("1"));
    assert.equal(
      await publicClient.getBalance({ address: dm.address }),
      parseEther("1"),
    );

    // 5. ETH native harus tetap mati.
    await assert.rejects(
      holderWallet.sendTransaction({
        to: dm.address,
        value: parseEther("1"),
        data: encodeFunctionData({
          abi: dm.abi,
          functionName: "deposit",
          args: [PROJECT_ID, zeroAddress, parseEther("1")],
        }),
      }),
      /NativeNotAccepted|revert/i,
    );

    // 6. Serahkan ownership ke Safe; setelah itu non-owner tidak bisa admin.
    await dm.write.transferOwnership([safeAddress]);
    assert.equal((await dm.read.owner()).toLowerCase(), safeAddress.toLowerCase());
    await assert.rejects(
      holderWallet.writeContract({
        address: dm.address,
        abi: dm.abi,
        functionName: "pause",
      }),
      /OwnableUnauthorizedAccount/,
    );
    await assert.rejects(
      holderWallet.writeContract({
        address: dm.address,
        abi: dm.abi,
        functionName: "rescueToken",
        args: [USDG, USDG_HOLDER, 1n],
      }),
      /OwnableUnauthorizedAccount/,
    );

    // 7. Pause/unpause lewat eksekusi Safe asli (2-of-3, approved hash).
    await execSafe(
      dm.address,
      encodeFunctionData({ abi: dm.abi, functionName: "pause" }),
    );
    assert.equal(await dm.read.paused(), true);
    await execSafe(
      dm.address,
      encodeFunctionData({ abi: dm.abi, functionName: "unpause" }),
    );
    assert.equal(await dm.read.paused(), false);
    console.log("[fork] pause/unpause lewat Safe 2-of-3 sukses");
    console.log("[fork] ownership terkunci ke Safe; admin non-owner ditolak");
  });
});
