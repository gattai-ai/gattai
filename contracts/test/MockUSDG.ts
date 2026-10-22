import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { parseUnits } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

describe("MockUSDG", async function () {
  const { viem } = await network.create();
  const [deployer, holder] = await viem.getWalletClients();

  async function deploy() {
    return viem.deployContract("MockUSDG", [ZERO]);
  }

  it("memakai 6 desimal seperti USDG mainnet", async function () {
    const token = await deploy();
    assert.equal(await token.read.decimals(), 6);
    assert.equal(await token.read.symbol(), "USDG");
  });

  it("faucet bisa mint ke alamat mana pun", async function () {
    const token = await deploy();
    const amount = parseUnits("25", 6);

    await token.write.faucet([holder.account.address, amount], {
      account: deployer.account,
    });

    assert.equal(await token.read.balanceOf([holder.account.address]), amount);
  });

  it("mint dibatasi minter saat minter diisi", async function () {
    const token = await viem.deployContract("MockUSDG", [deployer.account.address]);
    const amount = parseUnits("1", 6);

    await token.write.mint([holder.account.address, amount], {
      account: deployer.account,
    });

    await viem.assertions.revert(
      token.write.mint([holder.account.address, amount], {
        account: holder.account,
      }),
    );
  });
});
