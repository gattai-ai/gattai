import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useConnection,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { parseUnits, zeroAddress, type Hash } from "viem";
import { depositManagerAbi } from "@shared/contracts";
import { type SupportedChainId } from "@shared/chains";
import { api } from "@/lib/api";
import { showToast } from "@/site/siteFx";
import { useBalance } from "@/features/balance/useBalance";
import { useCapSettings, useSpentToday } from "./cap";
import { NeedLogin } from "./AppShell";
import { useSession } from "@/lib/use-session";
import { isUserRejection, walletErrorMessage } from "@/lib/wallet-error";
import type { DepositConfig, DepositConfirmResponse, ProjectInfo } from "@/lib/types";

/**
 * Balance & top-up dengan tampilan situs statis. Data lot/saldo nyata dari
 * API; deposit onchain nyata via wagmi. Harga demo diganti: USDG 1:1,
 * ETH/GATTAI dikonversi saat indexer memproses (setelah konfirmasi).
 */

const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

type Phase = "idle" | "approving" | "depositing" | "confirming" | "crediting" | "done";

function formatInt(value: number): string {
  return Math.floor(value).toLocaleString("en-US");
}

export function BalanceView() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const { address, isConnected, chainId } = useConnection();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { data: balance } = useBalance();

  const { data: config } = useQuery({
    queryKey: ["deposit-config"],
    queryFn: () => api<DepositConfig>("/v1/public/deposits/config"),
    staleTime: 5 * 60_000,
  });
  const { data: project } = useQuery({
    queryKey: ["project", session?.projectId],
    queryFn: () => api<ProjectInfo>("/v1/project"),
    enabled: Boolean(session),
  });

  const [symbol, setSymbol] = useState("ETH");
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [approveHash, setApproveHash] = useState<Hash | undefined>();
  const [depositHash, setDepositHash] = useState<Hash | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [litDots, setLitDots] = useState(0);

  const { settings: cap, setSettings: setCap } = useCapSettings();
  const spentToday = useSpentToday();

  const { writeContractAsync } = useWriteContract();
  const approveReceipt = useWaitForTransactionReceipt({ hash: approveHash });
  const depositReceipt = useWaitForTransactionReceipt({ hash: depositHash });

  const tokens = config?.tokens ?? [];
  const token = tokens.find((item) => item.symbol === symbol) ?? tokens[0];
  const depositManager = config?.deposit_manager ?? null;
  const projectId = project?.onchain_id ?? null;
  const isNative = token ? token.address.toLowerCase() === zeroAddress : true;

  let amountRaw = 0n;
  let parseError = false;
  if (token && amount.trim() !== "") {
    try {
      amountRaw = parseUnits(amount.trim(), token.decimals);
    } catch {
      parseError = true;
    }
  }

  const { data: allowance } = useReadContract({
    address: token && !isNative ? (token.address as `0x${string}`) : undefined,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && depositManager ? [address, depositManager as `0x${string}`] : undefined,
    query: { enabled: Boolean(address && depositManager && token && !isNative) },
  });

  const needApprove = !isNative && allowance !== undefined && amountRaw > allowance;
  // Selama allowance belum termuat untuk token ERC-20, kunci tombol agar tidak
  // mengirim deposit yang pasti revert (alih-alih menebak perlu approve).
  const allowanceUnknown = !isNative && Boolean(address && depositManager) && allowance === undefined;

  const dots = config ? Math.min(Math.max(config.confirmations, 1), 8) : 5;

  async function doDeposit() {
    if (!depositManager || !projectId || !token) return;
    setPhase("depositing");
    const hash = await writeContractAsync({
      address: depositManager as `0x${string}`,
      abi: depositManagerAbi,
      functionName: "deposit",
      args: [projectId as `0x${string}`, token.address as `0x${string}`, amountRaw],
      value: isNative ? amountRaw : 0n,
    });
    setDepositHash(hash);
    setPhase("confirming");
  }

  // Lanjutkan otomatis setelah approve terkonfirmasi (dan bukan revert).
  useEffect(() => {
    if (phase !== "approving") return;
    const receipt = approveReceipt.data;
    if (!receipt) return;
    if (receipt.status === "reverted") {
      setError("Approval reverted onchain.");
      setPhase("idle");
      return;
    }
    if (receipt.status !== "success") return;
    void (async () => {
      try {
        await doDeposit();
      } catch (cause) {
        // Penolakan pengguna bukan error: kembalikan ke idle tanpa pesan merah.
        if (!isUserRejection(cause)) {
          setError(walletErrorMessage(cause, "Deposit failed. Try again."));
        }
        setPhase("idle");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, approveReceipt.data]);

  // Setelah receipt deposit: bedakan sukses vs revert, lalu mulai mengkredit.
  useEffect(() => {
    if (phase !== "confirming") return;
    const receipt = depositReceipt.data;
    if (!receipt) return;
    if (receipt.status === "reverted") {
      setError("Deposit transaction reverted onchain. No credits were added.");
      setPhase("idle");
      void queryClient.invalidateQueries({ queryKey: ["balance"] });
      return;
    }
    if (receipt.status !== "success") return;
    setPhase("crediting");
  }, [phase, depositReceipt.data, queryClient]);

  // Polling konfirmasi instan ke backend (maks ~30 detik); sisanya diserahkan
  // ke reconciler di server bila gagal/timeout.
  useEffect(() => {
    if (phase !== "crediting" || !depositHash) return;
    let cancelled = false;

    void (async () => {
      for (let attempt = 0; attempt < 15 && !cancelled; attempt++) {
        let result: DepositConfirmResponse;
        try {
          result = await api<DepositConfirmResponse>("/v1/deposits/confirm", {
            method: "POST",
            body: { tx_hash: depositHash },
          });
        } catch (cause) {
          if (cancelled) return;
          setError(walletErrorMessage(cause, "Could not confirm the deposit."));
          setPhase("done");
          return;
        }
        if (cancelled) return;

        if (result.status === "credited" || result.status === "duplicate") {
          await queryClient.invalidateQueries({ queryKey: ["balance"] });
          if (cancelled) return;
          showToast(
            result.credits_added && result.credits_added > 0
              ? `Credits added · +${formatInt(result.credits_added)}`
              : "Deposit already credited",
          );
          setPhase("done");
          return;
        }
        if (result.status === "over_cap") {
          setError("Deposit exceeds the per-deposit cap.");
          setPhase("done");
          return;
        }
        if (result.status === "dust") {
          setError("Deposit is too small to credit.");
          setPhase("done");
          return;
        }
        if (result.status === "unpriced") {
          setError("Price is not available yet; credits will follow automatically.");
          setPhase("done");
          return;
        }
        if (result.status === "unknown_token") {
          setError("Unrecognized deposit token.");
          setPhase("done");
          return;
        }
        // status === "pending" → tunggu lalu coba lagi.
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!cancelled) {
        showToast("Deposit confirmed: credits will follow automatically.");
        setPhase("done");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [phase, depositHash, queryClient]);

  // Animasi titik konfirmasi selama menunggu (seperti situs statis).
  useEffect(() => {
    if (phase !== "confirming") {
      setLitDots(0);
      return;
    }
    setLitDots(1);
    const timer = window.setInterval(() => {
      setLitDots((value) => (value >= dots ? 1 : value + 1));
    }, 600);
    return () => window.clearInterval(timer);
  }, [phase, dots]);

  function reset() {
    setPhase("idle");
    setApproveHash(undefined);
    setDepositHash(undefined);
    setError(null);
    setAmount("");
  }

  async function onDeposit() {
    setError(null);
    if (!depositManager || !projectId || !token) return;
    try {
      if (needApprove) {
        setPhase("approving");
        const hash = await writeContractAsync({
          address: token.address as `0x${string}`,
          abi: erc20Abi,
          functionName: "approve",
          args: [depositManager as `0x${string}`, amountRaw],
        });
        setApproveHash(hash);
        return;
      }
      await doDeposit();
    } catch (cause) {
      if (!isUserRejection(cause)) {
        setError(walletErrorMessage(cause, "Transaction failed. Try again."));
      }
      setPhase("idle");
    }
  }

  if (!session) return <NeedLogin action="Balance" />;

  const credits = balance?.balance_credits ?? 0;
  const lots = [...(balance?.lots ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const activeLots = lots.filter((lot) => lot.remaining_micro > 0);
  // Jatah media dihitung terpisah dari kuota teks (anggaran mandiri, §2 dokumen).
  const trial = project?.trial;
  const mediaLeft =
    trial?.media_limit != null && trial.media_used != null
      ? Math.max(0, trial.media_limit - trial.media_used)
      : null;

  const amountNum = Number(amount || "0");
  const isUsdg = token?.symbol === "USDG";
  // Harga USD per token berasal dari backend (`price_usd`). USDG selalu 1:1
  // sehingga tetap punya nilai walau backend tidak sempat mengirim harga.
  const tokenPrice = token?.price_usd ?? (isUsdg ? 1 : null);
  const hasAmount = amount.trim() !== "" && Number.isFinite(amountNum) && amountNum > 0;
  const usdValue = hasAmount && tokenPrice != null ? amountNum * tokenPrice : null;
  const quotedCredits = usdValue != null ? Math.floor(usdValue * 100) : null;
  const gattaiBonus = token?.symbol === "GATTAI" && quotedCredits != null && config
    ? Math.floor(quotedCredits / (1 - config.discount_ratio)) - quotedCredits
    : null;
  const overCap = usdValue != null && config ? usdValue > config.cap_usd : false;
  const wrongChain = config ? chainId !== config.chain_id : false;

  return (
    <section className="view on" id="v-balance">
      <div className="grid2">
        <div className="box bigbal">
          <h4>Project balance</h4>
          <div className="n">
            <span className="balN">{formatInt(credits)}</span>
            <small>credits</small>
          </div>
          <div className="u">
            ≈ $<span className="balU">{(credits / 100).toFixed(2)}</span> ·{" "}
            <span id="lotCount">{activeLots.length}</span> active lots · consumed FIFO
          </div>
          {trial && (trial.remaining > 0 || (mediaLeft ?? 0) > 0) && (
            <div className="u">
              Free trial: <span className="balU">{trial.remaining}</span> of {trial.limit} prompts left
              {mediaLeft != null
                ? mediaLeft > 0
                  ? ` · ${mediaLeft} media ${mediaLeft === 1 ? "run" : "runs"} left`
                  : " · media runs used up"
                : ""}
            </div>
          )}
        </div>

        <div className="box topup">
          <h4>Top up on Robinhood Chain</h4>
          {!config || !depositManager || !token ? (
            <div className="empty" style={{ marginTop: 18 }}>
              Top-up is not active yet: the DepositManager contract has not been deployed/configured
              in this environment.
            </div>
          ) : (
            <>
              <div className="row">
                <div className="field">
                  <label>Pay with</label>
                  <div className="seg" id="tokSeg">
                    {tokens.map((item) => (
                      <button
                        key={item.symbol}
                        data-t={item.symbol}
                        className={item.symbol === token.symbol ? "on" : undefined}
                        onClick={() => {
                          setSymbol(item.symbol);
                          reset();
                        }}
                      >
                        {item.symbol === "GATTAI" ? "$GATTAI −15%" : item.symbol}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="amt">
                    Amount (<span id="tokLab">{token.symbol === "GATTAI" ? "$GATTAI" : token.symbol}</span>)
                  </label>
                  <input
                    className="inp"
                    id="amt"
                    type="number"
                    min="0"
                    step="any"
                    value={amount}
                    inputMode="decimal"
                    onChange={(event) => setAmount(event.target.value)}
                  />
                </div>
              </div>
              <div className="quote">
                <div>
                  <span>
                    USD value{" "}
                    <small className="mono" id="priceSrc" style={{ color: "var(--dim)" }}>
                      {isUsdg
                        ? "· 1:1"
                        : tokenPrice != null
                          ? `· ${token.symbol} @ $${tokenPrice.toLocaleString("en-US")}`
                          : "· price unavailable"}
                    </small>
                  </span>
                  <b id="qUsd">{usdValue != null ? `$${usdValue.toFixed(2)}` : "-"}</b>
                </div>
                <div>
                  <span>$GATTAI discount</span>
                  <b className="disc" id="qDisc">
                    {token.symbol === "GATTAI" && gattaiBonus != null
                      ? `+ ${formatInt(gattaiBonus)} cr (${Math.round((config?.discount_ratio ?? 0) * 100)}%)`
                      : "-"}
                  </b>
                </div>
                <div>
                  <span>You receive</span>
                  <b id="qCr">
                    {quotedCredits != null
                      ? `${formatInt(quotedCredits + (gattaiBonus ?? 0))} credits`
                      : tokenPrice == null && hasAmount
                        ? "price unavailable for this token"
                        : "calculated after confirmations"}
                  </b>
                </div>
              </div>
              <div className="act">
                {phase === "done" ? (
                  <>
                    <button className="btn btn-dark" onClick={reset}>
                      Top up again
                    </button>
                    <small>
                      Deposit confirmed{depositHash ? ` · ${depositHash.slice(0, 10)}…` : ""}: credits
                      added to your balance.
                    </small>
                  </>
                ) : (
                  <>
                    <button
                      className="btn btn-acc"
                      id="depBtn"
                      disabled={
                        !isConnected ||
                        wrongChain ||
                        overCap ||
                        parseError ||
                        amountRaw <= 0n ||
                        !projectId ||
                        allowanceUnknown ||
                        (hasAmount && tokenPrice == null) ||
                        phase !== "idle"
                      }
                      onClick={() => void onDeposit()}
                    >
                      {phase === "approving"
                        ? "Approving…"
                        : phase === "depositing"
                          ? "Depositing…"
                          : phase === "confirming"
                            ? "Confirming…"
                            : phase === "crediting"
                              ? "Crediting…"
                              : needApprove
                                ? "Approve & deposit"
                                : "Deposit"}
                    </button>
                    <small id="depNote">
                      {!isConnected
                        ? "Connect a wallet to deposit"
                        : wrongChain
                          ? `Switch to chain ${config.chain_id} to deposit`
                          : overCap
                            ? `Over the per-deposit cap ($${config.cap_usd})`
                            : !projectId
                              ? "Project onchain id not ready yet"
                              : hasAmount && tokenPrice == null
                                ? `Live price for ${token.symbol} is unavailable, deposit cannot be valued`
                                : isNative || isUsdg
                                  ? "Credits are added automatically after confirmation"
                                  : "Approve once, then deposit"}
                    </small>
                  </>
                )}
                {isConnected && wrongChain && (
                  <button
                    className="btn btn-dark btn-sm"
                    disabled={isSwitching}
                    onClick={() => switchChain({ chainId: config.chain_id as SupportedChainId })}
                  >
                    Switch chain
                  </button>
                )}
              </div>
              {error && <div className="errbox" style={{ marginTop: 12 }}>{error}</div>}
              <div className={`conf${phase === "confirming" || phase === "crediting" ? " on" : ""}`} id="conf">
                <span id="confT">
                  {phase === "crediting" ? "Crediting your deposit" : "Waiting for confirmations"}
                </span>
                <span className="dots">
                  {Array.from({ length: dots }, (_, index) => (
                    <i key={index} className={index < litDots ? "on" : undefined}></i>
                  ))}
                </span>
              </div>
            </>
          )}
        </div>

        <div className="box lots">
          <h4>Credit lots</h4>
          <div className="tscroll" style={{ marginTop: 14 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Lot</th>
                  <th>Source</th>
                  <th className="num">Deposited</th>
                  <th className="num">Remaining</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody id="lotRows">
                {lots.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      No lots yet: top up to add credits.
                    </td>
                  </tr>
                )}
                {lots.map((lot) => (
                  <tr key={lot.id}>
                    <td className="m">{lot.id}</td>
                    <td>
                      <span
                        className={`st ${lot.source === "GATTAI" ? "acc" : lot.source === "PROMO" ? "dim" : "ok"}`}
                      >
                        {lot.source}
                      </span>
                    </td>
                    <td className="num m">{formatInt(lot.amount_credits)}</td>
                    <td className="num m">{lot.remaining_credits.toFixed(2)}</td>
                    <td className="m">
                      {new Date(lot.created_at).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="box cap">
          <h4>Daily spending cap</h4>
          <div className="rowx">
            <span>Enforce cap</span>
            <button
              className={`sw${cap.on ? " on" : ""}`}
              id="capSw"
              aria-label="Toggle spending cap"
              onClick={() => setCap({ on: !cap.on, value: cap.value })}
            ></button>
          </div>
          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="capIn">Credits per day</label>
            <input
              className="inp"
              id="capIn"
              type="number"
              min="0"
              value={cap.value}
              onChange={(event) => setCap({ on: cap.on, value: Math.max(0, Number(event.target.value) || 0) })}
            />
          </div>
          <p>
            Runs that would exceed the cap are rejected before any model is called. Spent today:{" "}
            <b id="spentToday" className="mono">
              {spentToday.toFixed(2)}
            </b>{" "}
            cr.
          </p>
        </div>
      </div>
    </section>
  );
}
