// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title GattaiToken ($GATTAI)
 * @notice Token ERC-20 dengan supply tetap untuk ekosistem GATTAI.
 *
 * Aturan (lihat Brief Developer §10.2 dan docs/06-billing-and-tokenomics.md):
 * - Supply tetap: seluruh supply di-mint sekali di constructor ke treasury.
 * - TIDAK ADA fungsi mint, sehingga supply tidak bisa bertambah.
 * - Ada `burn` dan `burnFrom` (ERC20Burnable) untuk buyback & burn.
 * - Ada `permit` (ERC20Permit) untuk approval gasless di masa depan.
 * - Ownership TIDAK dipakai dan langsung di-renounce di constructor,
 *   sehingga setelah deploy token sepenuhnya ownerless (owner() == address(0)).
 */
contract GattaiToken is ERC20, ERC20Burnable, ERC20Permit, Ownable {
  /**
   * @param treasury Alamat yang menerima seluruh supply awal (treasury multisig).
   * @param initialSupply Jumlah supply awal dalam satuan terkecil (wei token, 18 desimal).
   */
  constructor(
    address treasury,
    uint256 initialSupply
  ) ERC20("GATTAI", "GATTAI") ERC20Permit("GATTAI") Ownable(msg.sender) {
    require(treasury != address(0), "GattaiToken: treasury is zero");
    require(initialSupply > 0, "GattaiToken: supply is zero");

    _mint(treasury, initialSupply);

    // Supaya tidak ada admin function tersisa setelah deploy.
    renounceOwnership();
  }
}
