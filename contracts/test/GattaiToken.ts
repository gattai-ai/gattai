import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { parseSignature } from "viem";

const TOKEN = 10n ** 18n;
const SUPPLY = 1_000_000_000n * TOKEN; // 1 miliar $GATTAI
const ZERO = "0x0000000000000000000000000000000000000000" as const;

describe("GattaiToken", async function () {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [deployer, holder] = await viem.getWalletClients();
  const treasury = deployer.account.address;

  async function deploy() {
    return viem.deployContract("GattaiToken", [treasury, SUPPLY]);
  }

  it("nama & symbol adalah GATTAI", async function () {
    const token = await deploy();
    assert.equal(await token.read.name(), "GATTAI");
    assert.equal(await token.read.symbol(), "GATTAI");
    assert.equal(await token.read.decimals(), 18);
  });

  it("supply awal di-mint seluruhnya ke treasury dan tetap", async function () {
    const token = await deploy();
    assert.equal(await token.read.totalSupply(), SUPPLY);
    assert.equal(await token.read.balanceOf([treasury]), SUPPLY);
  });

  it("ownership di-renounce: owner() == address(0)", async function () {
    const token = await deploy();
    assert.equal(await token.read.owner(), ZERO);
  });

  it("tidak memiliki fungsi mint di ABI", async function () {
    const token = await deploy();
    const functionNames: string[] = token.abi
      .filter((item) => item.type === "function")
      .map((item) => String(item.name));
    assert.equal(functionNames.includes("mint"), false);
  });

  it("burn mengurangi totalSupply dan saldo pemanggil", async function () {
    const token = await deploy();
    const amount = 1_000n * TOKEN;

    await token.write.burn([amount]);
    assert.equal(await token.read.totalSupply(), SUPPLY - amount);
    assert.equal(await token.read.balanceOf([treasury]), SUPPLY - amount);
  });

  it("burnFrom memakai allowance", async function () {
    const token = await deploy();
    const amount = 500n * TOKEN;

    await token.write.approve([holder.account.address, amount]);
    await token.write.burnFrom([treasury, amount], { account: holder.account });

    assert.equal(await token.read.totalSupply(), SUPPLY - amount);
    assert.equal(await token.read.allowance([treasury, holder.account.address]), 0n);
  });

  it("transfer biasa tetap berfungsi setelah renounce", async function () {
    const token = await deploy();
    const amount = 42n * TOKEN;

    const hash = token.write.transfer([holder.account.address, amount]);
    await publicClient.waitForTransactionReceipt({ hash: await hash });

    assert.equal(await token.read.balanceOf([holder.account.address]), amount);
  });

  it("permit memberi allowance tanpa transaksi approve", async function () {
    const token = await deploy();
    const value = 123n * TOKEN;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const nonce = await token.read.nonces([deployer.account.address]);
    const chainId = await publicClient.getChainId();

    const signature = await deployer.signTypedData({
      account: deployer.account,
      domain: {
        name: "GATTAI",
        version: "1",
        chainId,
        verifyingContract: token.address,
      },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: {
        owner: deployer.account.address,
        spender: holder.account.address,
        value,
        nonce,
        deadline,
      },
    });
    const { r, s, yParity } = parseSignature(signature);

    await token.write.permit([
      deployer.account.address,
      holder.account.address,
      value,
      deadline,
      27 + yParity,
      r,
      s,
    ]);

    assert.equal(
      await token.read.allowance([deployer.account.address, holder.account.address]),
      value,
    );
    assert.equal(await token.read.nonces([deployer.account.address]), nonce + 1n);
  });
});
