// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title DepositManager
 * @notice Menerima top-up credits GATTAI onchain (ETH, USDG, atau $GATTAI).
 *
 * Aturan (lihat Brief Developer §10.2 dan docs/06-billing-and-tokenomics.md §3.2):
 * - `deposit(projectId, token, amount)` untuk ETH native (`token == address(0)`),
 *   atau token ERC-20 yang sudah di-allowlist (USDG / GATTAI).
 * - Meng-emit `Deposited(projectId, payer, token, amount)` untuk dibaca indexer.
 * - Dana langsung diteruskan ke `treasury` (multisig). Kontrak ini TIDAK menyimpan dana.
 * - TIDAK ADA fungsi penarikan oleh pengguna. Credits tidak dapat di-refund.
 * - Idempotency dan pencatatan credit_lot dilakukan indexer secara offchain.
 *
 * Keamanan: `Pausable` + `ReentrancyGuard`, transfer ERC-20 memakai `SafeERC20`,
 * dan jumlah yang dicatat dihitung dari selisih saldo (aman untuk token
 * fee-on-transfer). Owner adalah treasury multisig.
 *
 * `rescueToken`/`rescueNative` hanya untuk dana yang salah kirim ke kontrak,
 * bukan untuk menarik dana deposit. Dana deposit selalu diteruskan ke treasury
 * dalam transaksi yang sama.
 */
contract DepositManager is Ownable, Pausable, ReentrancyGuard {
  using SafeERC20 for IERC20;

  /// @dev `address(0)` merepresentasikan ETH native.
  address public constant NATIVE = address(0);

  /// @notice Alamat penerima seluruh dana deposit (treasury multisig).
  address public immutable treasury;

  /// @notice Allowlist token ERC-20 yang diterima (USDG, GATTAI, ...).
  mapping(address token => bool accepted) public acceptedToken;

  /**
   * @notice Batas jumlah per deposit. `0` berarti tanpa batas.
   * @dev Untuk ETH native gunakan alamat `NATIVE`. Batas ini dalam satuan token,
   * bukan USD; backend tetap menegakkan batas USD. Tujuannya menjadi backstop
   * agar dana over-cap tidak masuk treasury dan tidak perlu refund manual.
   */
  mapping(address token => uint256 amount) public maxAmount;

  /**
   * @notice Apakah deposit ETH native diterima.
   * @dev Bisa dimatikan saat peluncuran bertahap (USDG-first) supaya ETH yang
   * dikirim langsung tidak masuk ke treasury tanpa harga yang terverifikasi.
   */
  bool public nativeAccepted = true;

  event Deposited(
    bytes32 indexed projectId,
    address indexed payer,
    address indexed token,
    uint256 amount
  );
  event TokenAccepted(address indexed token, bool accepted);
  event NativeAccepted(bool accepted);
  event MaxAmountSet(address indexed token, uint256 amount);
  event Rescued(address indexed token, address indexed to, uint256 amount);

  error ZeroProjectId();
  error ZeroAmount();
  error AmountMismatch();
  error TokenNotAccepted(address token);
  error NativeTokenNotAllowlistable();
  error NativeNotAccepted();
  error TreasuryTransferFailed();
  error InvalidTreasury();
  error NotAContract();
  error AmountAboveMax(uint256 amount, uint256 max);
  error ZeroAddress();
  error InsufficientBalance();
  error RescueTransferFailed();
  error OwnerMustBeTreasury();
  error RenounceOwnershipDisabled();

  /**
   * @param treasury_ Alamat treasury yang menerima seluruh dana deposit.
   */
  constructor(address treasury_) Ownable(msg.sender) {
    if (treasury_ == address(0) || treasury_ == address(this)) revert InvalidTreasury();
    treasury = treasury_;
  }

  /// @dev Menolak ETH yang dikirim langsung tanpa lewat `deposit()`.
  receive() external payable {
    revert("DepositManager: use deposit()");
  }

  /**
   * @notice Melakukan deposit dan meneruskan dana ke treasury.
   * @param projectId ID project onchain (`bytes32`), bukan nilai nol.
   * @param token Alamat token ERC-20, atau `address(0)` untuk ETH native.
   * @param amount Untuk ETH native: harus sama dengan `msg.value`.
   *   Untuk ERC-20: jumlah token yang ditarik dari `msg.sender`.
   */
  function deposit(
    bytes32 projectId,
    address token,
    uint256 amount
  ) external payable nonReentrant whenNotPaused {
    if (projectId == bytes32(0)) revert ZeroProjectId();

    uint256 received;

    if (token == NATIVE) {
      if (!nativeAccepted) revert NativeNotAccepted();
      if (msg.value == 0) revert ZeroAmount();
      if (amount != msg.value) revert AmountMismatch();

      received = msg.value;
      _enforceMax(token, received);
      _forwardNative(received);
    } else {
      if (msg.value != 0) revert AmountMismatch();
      if (!acceptedToken[token]) revert TokenNotAccepted(token);
      if (amount == 0) revert ZeroAmount();
      _enforceMax(token, amount);

      uint256 balanceBefore = IERC20(token).balanceOf(address(this));
      IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
      received = IERC20(token).balanceOf(address(this)) - balanceBefore;
      if (received == 0) revert ZeroAmount();

      IERC20(token).safeTransfer(treasury, received);
    }

    emit Deposited(projectId, msg.sender, token, received);
  }

  /**
   * @notice Menambah/menghapus token ERC-20 dari allowlist.
   * @dev ETH native diatur lewat `setNativeAccepted`, bukan allowlist token.
   * Alamat yang di-allowlist wajib memiliki bytecode; EOA akan ditolak.
   */
  function setTokenAccepted(address token, bool accepted) external onlyOwner {
    if (token == NATIVE) revert NativeTokenNotAllowlistable();
    if (accepted && token.code.length == 0) revert NotAContract();
    acceptedToken[token] = accepted;
    emit TokenAccepted(token, accepted);
  }

  /**
   * @notice Mengatur batas jumlah per deposit untuk token/native.
   * @dev `0` berarti tanpa batas. Untuk native gunakan `NATIVE`.
   */
  function setMaxAmount(address token, uint256 amount) external onlyOwner {
    maxAmount[token] = amount;
    emit MaxAmountSet(token, amount);
  }

  /**
   * @notice Mengaktifkan/mematikan deposit ETH native.
   * @dev Dipakai untuk peluncuran bertahap: USDG dulu, ETH setelah feed harga
   * dan operasi treasury siap.
   */
  function setNativeAccepted(bool accepted) external onlyOwner {
    nativeAccepted = accepted;
    emit NativeAccepted(accepted);
  }

  /// @notice Menyelamatkan token ERC-20 yang salah kirim ke kontrak ini.
  function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
    if (token == NATIVE) revert NativeTokenNotAllowlistable();
    if (to == address(0)) revert ZeroAddress();
    if (amount == 0) revert ZeroAmount();

    IERC20(token).safeTransfer(to, amount);
    emit Rescued(token, to, amount);
  }

  /// @notice Menyelamatkan ETH yang dipaksa masuk ke kontrak ini.
  function rescueNative(address to, uint256 amount) external onlyOwner nonReentrant {
    if (to == address(0)) revert ZeroAddress();
    if (amount == 0) revert ZeroAmount();
    if (address(this).balance < amount) revert InsufficientBalance();

    (bool ok, ) = payable(to).call{value: amount}("");
    if (!ok) revert RescueTransferFailed();
    emit Rescued(NATIVE, to, amount);
  }

  /// @notice Menghentikan sementara semua deposit (keadaan darurat).
  function pause() external onlyOwner {
    _pause();
  }

  /// @notice Mengaktifkan kembali deposit setelah dijeda.
  function unpause() external onlyOwner {
    _unpause();
  }

  /**
   * @dev Ownership dan treasury harus tetap satu alamat. Rotasi treasury berarti
   * deploy DepositManager baru; ini mencegah dana masuk ke treasury lama.
   */
  function transferOwnership(address newOwner) public override onlyOwner {
    if (newOwner != treasury) revert OwnerMustBeTreasury();
    super.transferOwnership(newOwner);
  }

  /// @dev Renounce akan mematikan pause/allowlist selamanya. Jangan diizinkan.
  function renounceOwnership() public view override onlyOwner {
    revert RenounceOwnershipDisabled();
  }

  function _enforceMax(address token, uint256 amount) private view {
    uint256 cap = maxAmount[token];
    if (cap != 0 && amount > cap) revert AmountAboveMax(amount, cap);
  }

  function _forwardNative(uint256 amount) private {
    (bool ok, ) = treasury.call{value: amount}("");
    if (!ok) revert TreasuryTransferFailed();
  }
}
