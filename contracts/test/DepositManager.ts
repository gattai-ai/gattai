import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { keccak256, toHex } from "viem";

const TOKEN = 10n ** 18n;
const SUPPLY = 1_000_000n * TOKEN;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const PROJECT_ID = keccak256(toHex("project-demo"));
const ONE_ETHER = 1n * 10n ** 18n;

describe("DepositManager", async function () {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [deployer, user, treasuryWallet] = await viem.getWalletClients();
  const treasury = treasuryWallet.account.address;

  async function deploy() {
    return viem.deployContract("DepositManager", [treasury]);
  }

  async function deployCreditToken() {
    // GattaiToken dipakai sebagai ERC-20 generik untuk menguji jalur token.
    return viem.deployContract("GattaiToken", [deployer.account.address, SUPPLY]);
  }

  it("menyimpan alamat treasury dan owner = deployer", async function () {
    const dm = await deploy();
    assert.equal((await dm.read.treasury()).toLowerCase(), treasury.toLowerCase());
    assert.equal(
      (await dm.read.owner()).toLowerCase(),
      deployer.account.address.toLowerCase(),
    );
  });

  it("menolak ETH yang dikirim langsung (bukan lewat deposit())", async function () {
    const dm = await deploy();
    await viem.assertions.revert(
      deployer.sendTransaction({ to: dm.address, value: ONE_ETHER }),
    );
  });

  it("deposit ETH meneruskan dana ke treasury + emit Deposited", async function () {
    const dm = await deploy();
    const before = await publicClient.getBalance({ address: treasury });

    const hash = dm.write.deposit([PROJECT_ID, ZERO, ONE_ETHER], {
      value: ONE_ETHER,
    });
    await viem.assertions.emitWithArgs(hash, dm, "Deposited", [
      PROJECT_ID,
      deployer.account.address,
      ZERO,
      ONE_ETHER,
    ]);
    await publicClient.waitForTransactionReceipt({ hash: await hash });

    const after = await publicClient.getBalance({ address: treasury });
    assert.equal(after - before, ONE_ETHER);
    assert.equal(await publicClient.getBalance({ address: dm.address }), 0n);
  });

  it("deposit ERC-20 yang di-allowlist meneruskan token ke treasury", async function () {
    const dm = await deploy();
    const token = await deployCreditToken();
    const amount = 100n * TOKEN;

    await dm.write.setTokenAccepted([token.address, true]);
    await token.write.approve([dm.address, amount]);

    const hash = dm.write.deposit([PROJECT_ID, token.address, amount]);
    await viem.assertions.emitWithArgs(hash, dm, "Deposited", [
      PROJECT_ID,
      deployer.account.address,
      token.address,
      amount,
    ]);
    await publicClient.waitForTransactionReceipt({ hash: await hash });

    assert.equal(await token.read.balanceOf([treasury]), amount);
    assert.equal(await token.read.balanceOf([dm.address]), 0n);
  });

  it("owner bisa mematikan ETH native untuk peluncuran USDG-first", async function () {
    const dm = await deploy();
    assert.equal(await dm.read.nativeAccepted(), true);

    const hash = dm.write.setNativeAccepted([false]);
    await viem.assertions.emitWithArgs(hash, dm, "NativeAccepted", [false]);

    await viem.assertions.revertWithCustomError(
      dm.write.deposit([PROJECT_ID, ZERO, ONE_ETHER], { value: ONE_ETHER }),
      dm,
      "NativeNotAccepted",
    );

    await dm.write.setNativeAccepted([true]);
    const depositHash = dm.write.deposit([PROJECT_ID, ZERO, ONE_ETHER], {
      value: ONE_ETHER,
    });
    await viem.assertions.emitWithArgs(depositHash, dm, "Deposited", [
      PROJECT_ID,
      deployer.account.address,
      ZERO,
      ONE_ETHER,
    ]);
  });

  it("hanya owner yang bisa mengubah status ETH native", async function () {
    const dm = await deploy();
    await viem.assertions.revertWithCustomError(
      dm.write.setNativeAccepted([false], { account: user.account }),
      dm,
      "OwnableUnauthorizedAccount",
    );
  });

  it("menolak deposit projectId nol", async function () {
    const dm = await deploy();
    await viem.assertions.revertWithCustomError(
      dm.write.deposit([`0x${"0".repeat(64)}` as const, ZERO, ONE_ETHER], {
        value: ONE_ETHER,
      }),
      dm,
      "ZeroProjectId",
    );
  });

  it("menolak deposit ERC-20 yang belum di-allowlist", async function () {
    const dm = await deploy();
    const token = await deployCreditToken();
    await token.write.approve([dm.address, 1n * TOKEN]);

    await viem.assertions.revertWithCustomError(
      dm.write.deposit([PROJECT_ID, token.address, 1n * TOKEN]),
      dm,
      "TokenNotAccepted",
    );
  });

  it("menolak ERC-20 dengan msg.value", async function () {
    const dm = await deploy();
    const token = await deployCreditToken();
    await dm.write.setTokenAccepted([token.address, true]);
    await token.write.approve([dm.address, 1n * TOKEN]);

    await viem.assertions.revertWithCustomError(
      dm.write.deposit([PROJECT_ID, token.address, 1n * TOKEN], {
        value: 1n,
      }),
      dm,
      "AmountMismatch",
    );
  });

  it("menolak jumlah ETH nol", async function () {
    const dm = await deploy();
    await viem.assertions.revertWithCustomError(
      dm.write.deposit([PROJECT_ID, ZERO, 0n]),
      dm,
      "ZeroAmount",
    );
  });

  it("menolak amount != msg.value untuk ETH", async function () {
    const dm = await deploy();
    await viem.assertions.revertWithCustomError(
      dm.write.deposit([PROJECT_ID, ZERO, ONE_ETHER], { value: 2n * ONE_ETHER }),
      dm,
      "AmountMismatch",
    );
  });

  it("pause menghentikan deposit, unpause mengaktifkan kembali", async function () {
    const dm = await deploy();
    await dm.write.pause();

    await viem.assertions.revertWithCustomError(
      dm.write.deposit([PROJECT_ID, ZERO, ONE_ETHER], { value: ONE_ETHER }),
      dm,
      "EnforcedPause",
    );

    await dm.write.unpause();
    const hash = dm.write.deposit([PROJECT_ID, ZERO, ONE_ETHER], {
      value: ONE_ETHER,
    });
    await viem.assertions.emitWithArgs(hash, dm, "Deposited", [
      PROJECT_ID,
      deployer.account.address,
      ZERO,
      ONE_ETHER,
    ]);
  });

  it("hanya owner yang bisa mengubah allowlist", async function () {
    const dm = await deploy();
    const token = await deployCreditToken();

    await viem.assertions.revertWithCustomError(
      dm.write.setTokenAccepted([token.address, true], {
        account: user.account,
      }),
      dm,
      "OwnableUnauthorizedAccount",
    );
  });

  it("ETH native tidak bisa di-allowlist", async function () {
    const dm = await deploy();
    await viem.assertions.revertWithCustomError(
      dm.write.setTokenAccepted([ZERO, true]),
      dm,
      "NativeTokenNotAllowlistable",
    );
  });

  it("menolak treasury nol saat deploy", async function () {
    await assert.rejects(viem.deployContract("DepositManager", [ZERO]));
  });

  it("menolak allowlist alamat tanpa bytecode", async function () {
    const dm = await deploy();
    await viem.assertions.revertWithCustomError(
      dm.write.setTokenAccepted([user.account.address, true]),
      dm,
      "NotAContract",
    );
  });

  it("cap native menolak deposit di atas batas", async function () {
    const dm = await deploy();
    const hash = dm.write.setMaxAmount([ZERO, ONE_ETHER]);
    await viem.assertions.emitWithArgs(hash, dm, "MaxAmountSet", [ZERO, ONE_ETHER]);

    await viem.assertions.revertWithCustomError(
      dm.write.deposit([PROJECT_ID, ZERO, 2n * ONE_ETHER], {
        value: 2n * ONE_ETHER,
      }),
      dm,
      "AmountAboveMax",
    );

    await dm.write.deposit([PROJECT_ID, ZERO, ONE_ETHER], { value: ONE_ETHER });
    assert.equal(await publicClient.getBalance({ address: dm.address }), 0n);
  });

  it("cap ERC-20 menolak deposit di atas batas", async function () {
    const dm = await deploy();
    const token = await deployCreditToken();
    const cap = 50n * TOKEN;

    await dm.write.setTokenAccepted([token.address, true]);
    await dm.write.setMaxAmount([token.address, cap]);
    await token.write.approve([dm.address, 100n * TOKEN]);

    await viem.assertions.revertWithCustomError(
      dm.write.deposit([PROJECT_ID, token.address, cap + 1n]),
      dm,
      "AmountAboveMax",
    );

    await dm.write.deposit([PROJECT_ID, token.address, cap]);
    assert.equal(await token.read.balanceOf([treasury]), cap);
  });

  it("hanya owner yang bisa mengatur cap", async function () {
    const dm = await deploy();
    await viem.assertions.revertWithCustomError(
      dm.write.setMaxAmount([ZERO, ONE_ETHER], { account: user.account }),
      dm,
      "OwnableUnauthorizedAccount",
    );
  });

  it("owner bisa menyelamatkan token yang salah kirim", async function () {
    const dm = await deploy();
    const token = await deployCreditToken();
    const amount = 10n * TOKEN;

    await token.write.transfer([dm.address, amount]);
    const before = await token.read.balanceOf([treasury]);

    const hash = dm.write.rescueToken([token.address, treasury, amount]);
    await viem.assertions.emitWithArgs(hash, dm, "Rescued", [
      token.address,
      treasury,
      amount,
    ]);
    await publicClient.waitForTransactionReceipt({ hash: await hash });

    assert.equal(await token.read.balanceOf([treasury]), before + amount);
    assert.equal(await token.read.balanceOf([dm.address]), 0n);
  });

  it("rescue token hanya owner", async function () {
    const dm = await deploy();
    const token = await deployCreditToken();

    await viem.assertions.revertWithCustomError(
      dm.write.rescueToken([token.address, treasury, 1n], {
        account: user.account,
      }),
      dm,
      "OwnableUnauthorizedAccount",
    );
  });

  it("rescue native menolak saldo yang tidak cukup", async function () {
    const dm = await deploy();
    await viem.assertions.revertWithCustomError(
      dm.write.rescueNative([treasury, 1n]),
      dm,
      "InsufficientBalance",
    );
  });

  it("rescue native hanya owner", async function () {
    const dm = await deploy();
    await viem.assertions.revertWithCustomError(
      dm.write.rescueNative([treasury, 1n], { account: user.account }),
      dm,
      "OwnableUnauthorizedAccount",
    );
  });

  it("ownership terkunci ke treasury dan tidak bisa di-renounce", async function () {
    const dm = await deploy();

    await viem.assertions.revertWithCustomError(
      dm.read.renounceOwnership(),
      dm,
      "RenounceOwnershipDisabled",
    );
    await viem.assertions.revertWithCustomError(
      dm.write.transferOwnership([user.account.address]),
      dm,
      "OwnerMustBeTreasury",
    );

    const hash = dm.write.transferOwnership([treasury]);
    await viem.assertions.emitWithArgs(hash, dm, "OwnershipTransferred", [
      deployer.account.address,
      treasury,
    ]);
    await publicClient.waitForTransactionReceipt({ hash: await hash });

    assert.equal((await dm.read.owner()).toLowerCase(), treasury.toLowerCase());
    // Treasury sekarang memegang owner function.
    await dm.write.setNativeAccepted([false], { account: treasuryWallet.account });
  });
});
