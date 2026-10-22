import { describe, expect, test } from "bun:test";
import {
  assertProductionConfig,
  env,
  getProviderApiKey,
  MissingEnvError,
  missingProviderKeys,
  parseDepositSymbols,
  parseSiweDomains,
} from "../src/env";

/**
 * P0: secret sesi harus gagal-keras saat produksi, bukan diam-diam memakai
 * nilai contoh (yang berarti sesi bisa dipalsukan siapa pun).
 *
 * Mutasi `process.env` dijaga sinkron + selalu dipulihkan di `finally` supaya
 * tidak bocor ke berkas test lain.
 */

type EnvKey =
  | "NODE_ENV"
  | "SESSION_SECRET"
  | "HIGGSFIELD_API_KEY"
  | "SIWE_DOMAIN"
  | "FRONTEND_URL"
  | "DATABASE_URL"
  | "CHAIN_ID"
  | "DEPOSIT_MANAGER_ADDRESS"
  | "TREASURY_ADDRESS"
  | "USDG_TOKEN_ADDRESS"
  | "USDG_DECIMALS"
  | "DEPOSIT_CONFIRMATIONS"
  | "INDEXER_FROM_BLOCK"
  | "INDEXER_ENABLED"
  | "ROBINHOOD_RPC_URL"
  | "DEPOSIT_ENABLED_SYMBOLS"
  | "CHAINLINK_ETH_USD_FEED"
  | "GATTAI_TWAP_POOL"
  | "GATTAI_TOKEN_ADDRESS"
  | "BURN_EXECUTE"
  | "ALLOW_MANUAL_PRICES"
  | "ALLOW_UNVERIFIED_USDG"
  | "INDEXER_REORG_LOOKBACK"
  | "TRIAL_FREE_MEDIA_ATTEMPTS"
  | "PORT";

const KEYS: EnvKey[] = [
  "NODE_ENV",
  "SESSION_SECRET",
  "HIGGSFIELD_API_KEY",
  "SIWE_DOMAIN",
  "FRONTEND_URL",
  "DATABASE_URL",
  "CHAIN_ID",
  "DEPOSIT_MANAGER_ADDRESS",
  "TREASURY_ADDRESS",
  "USDG_TOKEN_ADDRESS",
  "USDG_DECIMALS",
  "DEPOSIT_CONFIRMATIONS",
  "INDEXER_FROM_BLOCK",
  "INDEXER_ENABLED",
  "ROBINHOOD_RPC_URL",
  "DEPOSIT_ENABLED_SYMBOLS",
  "CHAINLINK_ETH_USD_FEED",
  "GATTAI_TWAP_POOL",
  "GATTAI_TOKEN_ADDRESS",
  "BURN_EXECUTE",
  "ALLOW_MANUAL_PRICES",
  "ALLOW_UNVERIFIED_USDG",
  "INDEXER_REORG_LOOKBACK",
  "TRIAL_FREE_MEDIA_ATTEMPTS",
  "PORT",
];

function withPatchedEnv(patch: Partial<Record<EnvKey, string | undefined>>, fn: () => void): void {
  const saved = KEYS.map((key) => [key, process.env[key]] as const);
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("SESSION_SECRET di produksi", () => {
  test("kosong → gagal saat dibaca", () => {
    withPatchedEnv({ NODE_ENV: "production", SESSION_SECRET: undefined }, () => {
      expect(() => env.sessionSecret).toThrow();
    });
  });

  test("nilai contoh → gagal", () => {
    withPatchedEnv({ NODE_ENV: "production", SESSION_SECRET: "dev-insecure-session-secret" }, () => {
      expect(() => env.sessionSecret).toThrow();
    });
  });

  test("terlalu pendek (<32 karakter) → gagal", () => {
    withPatchedEnv({ NODE_ENV: "production", SESSION_SECRET: "x".repeat(31) }, () => {
      expect(() => env.sessionSecret).toThrow();
    });
  });

  test("acak & cukup panjang → dipakai", () => {
    const secret = "a".repeat(32);
    withPatchedEnv({ NODE_ENV: "production", SESSION_SECRET: secret }, () => {
      expect(env.sessionSecret).toBe(secret);
    });
  });

  test("di luar produksi → nilai contoh dipakai (dev tetap jalan)", () => {
    withPatchedEnv({ NODE_ENV: "test", SESSION_SECRET: undefined }, () => {
      expect(env.sessionSecret).toBe("dev-insecure-session-secret");
    });
  });
});

describe("MissingEnvError & peringatan key provider", () => {
  test("key provider kosong → MissingEnvError berbahasa Inggris", () => {
    withPatchedEnv({ NODE_ENV: "test", HIGGSFIELD_API_KEY: undefined }, () => {
      expect(() => getProviderApiKey("higgsfield")).toThrow(MissingEnvError);
      expect(() => getProviderApiKey("higgsfield")).toThrow(
        "Missing required environment variable: HIGGSFIELD_API_KEY",
      );
    });
  });

  test("missingProviderKeys hanya mendaftar yang kosong (untuk log startup)", () => {
    withPatchedEnv({ NODE_ENV: "test", HIGGSFIELD_API_KEY: undefined }, () => {
      const missing = missingProviderKeys();
      expect(missing).toContain("HIGGSFIELD_API_KEY");
      expect(missing).not.toContain("MIMO_API_KEY");
    });
  });
});

describe("parseSiweDomains", () => {
  test("daftar eksplisit: dipisah koma, di-trim, lowercase, tanpa duplikat", () => {
    expect(
      parseSiweDomains(" WWW.Gattai.Tech , localhost:5173 ,www.gattai.tech", undefined, false),
    ).toEqual(["www.gattai.tech", "localhost:5173"]);
  });

  test("menerima origin penuh (skema dibuang, port dipertahankan)", () => {
    expect(
      parseSiweDomains("https://www.gattai.tech, http://localhost:5174", undefined, false),
    ).toEqual(["www.gattai.tech", "localhost:5174"]);
  });

  test("kosong → diturunkan dari FRONTEND_URL", () => {
    expect(
      parseSiweDomains(undefined, "https://www.gattai.tech,https://gattai.tech", false),
    ).toEqual(["www.gattai.tech", "gattai.tech"]);
  });

  test("SIWE_DOMAIN eksplisit menang atas FRONTEND_URL", () => {
    expect(parseSiweDomains("www.gattai.tech", "https://preview.example", false)).toEqual([
      "www.gattai.tech",
    ]);
  });

  test("produksi: kosong / wildcard / campuran wildcard → gagal", () => {
    expect(() => parseSiweDomains(undefined, undefined, true)).toThrow();
    expect(() => parseSiweDomains("*", undefined, true)).toThrow();
    expect(() => parseSiweDomains("www.gattai.tech,*", undefined, true)).toThrow();
    // Wildcard dari FRONTEND_URL juga tidak boleh lolos saat SIWE_DOMAIN kosong.
    expect(() => parseSiweDomains("", "*", true)).toThrow();
  });

  test("produksi: daftar host nyata → diterima apa adanya", () => {
    expect(parseSiweDomains("www.gattai.tech,gattai.tech", undefined, true)).toEqual([
      "www.gattai.tech",
      "gattai.tech",
    ]);
  });

  test("non-produksi: wildcard diabaikan (bukan host), kosong mengembalikan []", () => {
    expect(parseSiweDomains("*", undefined, false)).toEqual([]);
    expect(parseSiweDomains(undefined, undefined, false)).toEqual([]);
  });

  test("env.siweDomains: produksi tanpa host apa pun → gagal (fail-fast boot)", () => {
    withPatchedEnv({ NODE_ENV: "production", SIWE_DOMAIN: "", FRONTEND_URL: "" }, () => {
      expect(() => env.siweDomains).toThrow();
    });
  });

  test("env.siweDomains: dev tanpa SIWE_DOMAIN → mengikuti FRONTEND_URL", () => {
    withPatchedEnv(
      { NODE_ENV: "test", SIWE_DOMAIN: "", FRONTEND_URL: "http://localhost:5173,http://localhost:5174" },
      () => {
        expect(env.siweDomains).toEqual(["localhost:5173", "localhost:5174"]);
      },
    );
  });

  test("env.siweDomains: dev tanpa host apa pun → host backend sendiri", () => {
    withPatchedEnv({ NODE_ENV: "test", SIWE_DOMAIN: "", FRONTEND_URL: "" }, () => {
      expect(env.siweDomains).toEqual([`localhost:${env.port}`]);
    });
  });
});

describe("env numerik & pemilihan aset", () => {
  test("PORT bukan angka → gagal, bukan NaN", () => {
    withPatchedEnv({ PORT: "abc" }, () => {
      expect(() => env.port).toThrow("PORT");
    });
  });

  test("parseDepositSymbols: produksi default USDG-only", () => {
    expect([...parseDepositSymbols(undefined, true)]).toEqual(["USDG"]);
  });

  test("parseDepositSymbols: menolak aset tak dikenal", () => {
    expect(() => parseDepositSymbols("USDG,DOGE", true)).toThrow("DOGE");
  });
});

describe("preflight produksi mainnet", () => {
  const base: Partial<Record<EnvKey, string | undefined>> = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://user:pass@localhost:5432/gattai",
    CHAIN_ID: "4663",
    DEPOSIT_MANAGER_ADDRESS: "0x1111111111111111111111111111111111111111",
    TREASURY_ADDRESS: "0x2222222222222222222222222222222222222222",
    USDG_TOKEN_ADDRESS: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    USDG_DECIMALS: "6",
    DEPOSIT_CONFIRMATIONS: "60",
    INDEXER_FROM_BLOCK: "123456",
    INDEXER_ENABLED: "false",
    INDEXER_REORG_LOOKBACK: "64",
    DEPOSIT_ENABLED_SYMBOLS: "USDG",
    CHAINLINK_ETH_USD_FEED: "",
    GATTAI_TWAP_POOL: "",
    GATTAI_TOKEN_ADDRESS: "",
    BURN_EXECUTE: "false",
    ALLOW_MANUAL_PRICES: "false",
    ALLOW_UNVERIFIED_USDG: "false",
    TRIAL_FREE_MEDIA_ATTEMPTS: "0",
  };

  test("konfigurasi USDG-only yang lengkap → lolos", () => {
    withPatchedEnv(base, () => {
      expect(() => assertProductionConfig()).not.toThrow();
    });
  });

  test("chain testnet di produksi → gagal", () => {
    withPatchedEnv({ ...base, CHAIN_ID: "46630" }, () => {
      expect(() => assertProductionConfig()).toThrow("4663");
    });
  });

  test("USDG non-kanonik → gagal (kecuali override eksplisit)", () => {
    withPatchedEnv(
      { ...base, USDG_TOKEN_ADDRESS: "0x3333333333333333333333333333333333333333" },
      () => {
        expect(() => assertProductionConfig()).toThrow("canonical");
      },
    );
  });

  test("ETH aktif tanpa feed harga → gagal", () => {
    withPatchedEnv(
      { ...base, DEPOSIT_ENABLED_SYMBOLS: "ETH,USDG", CHAINLINK_ETH_USD_FEED: "" },
      () => {
        expect(() => assertProductionConfig()).toThrow("CHAINLINK_ETH_USD_FEED");
      },
    );
  });

  test("INDEXER_FROM_BLOCK kosong → gagal (jangan scan dari head)", () => {
    withPatchedEnv({ ...base, INDEXER_FROM_BLOCK: undefined }, () => {
      expect(() => assertProductionConfig()).toThrow("INDEXER_FROM_BLOCK");
    });
  });

  test("INDEXER_FROM_BLOCK 0 → gagal", () => {
    withPatchedEnv({ ...base, INDEXER_FROM_BLOCK: "0" }, () => {
      expect(() => assertProductionConfig()).toThrow("INDEXER_FROM_BLOCK");
    });
  });

  test("DEPOSIT_CONFIRMATIONS kurang dari 60 → gagal", () => {
    withPatchedEnv({ ...base, DEPOSIT_CONFIRMATIONS: "59" }, () => {
      expect(() => assertProductionConfig()).toThrow("60");
    });
  });

  test("INDEXER_REORG_LOOKBACK tidak lebih besar dari konfirmasi → gagal", () => {
    withPatchedEnv({ ...base, INDEXER_REORG_LOOKBACK: "60" }, () => {
      expect(() => assertProductionConfig()).toThrow("INDEXER_REORG_LOOKBACK");
    });
  });

  test("aset selain USDG di Phase 1 → gagal walau feed harga tersedia", () => {
    withPatchedEnv(
      {
        ...base,
        DEPOSIT_ENABLED_SYMBOLS: "ETH,USDG",
        CHAINLINK_ETH_USD_FEED: "0xfeed",
      },
      () => {
        expect(() => assertProductionConfig()).toThrow("USDG");
      },
    );
  });

  test("GATTAI_TOKEN_ADDRESS terisi di Phase 1 → gagal", () => {
    withPatchedEnv(
      { ...base, GATTAI_TOKEN_ADDRESS: "0x4444444444444444444444444444444444444444" },
      () => {
        expect(() => assertProductionConfig()).toThrow("GATTAI_TOKEN_ADDRESS");
      },
    );
  });

  test("BURN_EXECUTE aktif di Phase 1 → gagal", () => {
    withPatchedEnv({ ...base, BURN_EXECUTE: "true" }, () => {
      expect(() => assertProductionConfig()).toThrow("BURN_EXECUTE");
    });
  });

  test("ALLOW_MANUAL_PRICES aktif di Phase 1 → gagal", () => {
    withPatchedEnv({ ...base, ALLOW_MANUAL_PRICES: "true" }, () => {
      expect(() => assertProductionConfig()).toThrow("ALLOW_MANUAL_PRICES");
    });
  });

  test("ALLOW_UNVERIFIED_USDG aktif di Phase 1 → gagal", () => {
    withPatchedEnv({ ...base, ALLOW_UNVERIFIED_USDG: "true" }, () => {
      expect(() => assertProductionConfig()).toThrow("ALLOW_UNVERIFIED_USDG");
    });
  });

  test("free media trial aktif di produksi → gagal", () => {
    withPatchedEnv({ ...base, TRIAL_FREE_MEDIA_ATTEMPTS: "2" }, () => {
      expect(() => assertProductionConfig()).toThrow("TRIAL_FREE_MEDIA_ATTEMPTS");
    });
  });
});
