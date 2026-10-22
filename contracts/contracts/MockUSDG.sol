// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDG
 * @notice Token ERC-20 tiruan untuk stablecoin USD di **testnet**.
 *
 * PENTING: kontrak ini HANYA untuk testnet/dev. Di mainnet, USDG adalah
 * stablecoin nyata (Global Dollar) dengan issuance & reserve yang diaudit.
 * Jangan pernah deploy kontrak ini di mainnet.
 *
 * Fitur:
 * - 6 desimal (standar stablecoin), harga dipatok 1:1 USD.
 * - `faucet()` untuk mengisi saldo sendiri (testnet saja).
 * - `mint()` controlled by owner untuk kebutuhan setup testnet.
 */
contract MockUSDG is ERC20 {
  /// @notice Alamat yang boleh memanggil `mint` (biarkan kosong = bebas, hanya testnet).
  address public immutable minter;

  constructor(address minter_) ERC20("USDG", "USDG") {
    minter = minter_;
  }

  /// @notice Samakan dengan stablecoin USDG di mainnet (6 desimal).
  function decimals() public pure override returns (uint8) {
    return 6;
  }

  /// @notice Isi saldo token untuk alamat tertentu (testnet faucet).
  function faucet(address to, uint256 amount) external {
    _mint(to, amount);
  }

  /// @notice Mint oleh minter yang sah (testnet setup).
  function mint(address to, uint256 amount) external {
    require(minter == address(0) || msg.sender == minter, "MockUSDG: not minter");
    _mint(to, amount);
  }

  /// @notice Fire-and-forget untuk menerima ETH (agar contract bisa jadi target).
  receive() external payable {}
}