import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Preload `bun test` frontend.
 *
 * 1. Daftarkan DOM happy-dom supaya komponen React bisa dirender tanpa browser.
 * 2. Nyalakan lingkungan `act` React 19 supaya pembaruan state dari query
 *    di-flush sebelum assertion (kalau tidak, test akan balapan dengan render).
 */
GlobalRegistrator.register();

// Lingkungan `act` React 19: tanpa ini pembaruan state query bisa balapan render.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
