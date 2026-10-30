import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({}));

import * as MobileDatabase from "./mobile-database";
import * as MobilePreferences from "./mobile-preferences";
import * as MobileSecureStorage from "./mobile-secure-storage";

function loadStored(stored: object) {
  const unused = Effect.die("unused");
  const database = MobileDatabase.MobileDatabase.of({
    loadCache: () => unused,
    listCache: () => unused,
    saveCache: () => unused,
    removeCache: () => unused,
    clearCacheKind: () => unused,
    clearEnvironmentCache: () => unused,
    clearAllCaches: unused,
    inspectCaches: unused,
    loadPreferencesJson: Effect.succeed(
      Option.some({ payload: JSON.stringify(stored), updatedAt: 1 }),
    ),
    savePreferencesJson: () => Effect.void,
  });
  const secureStorage = MobileSecureStorage.MobileSecureStorage.of({
    getItem: () => Effect.succeed(null),
    setItem: () => Effect.void,
    removeItem: () => Effect.void,
  });
  return Effect.gen(function* () {
    const store = yield* MobilePreferences.MobilePreferencesStore;
    return yield* store.load;
  }).pipe(
    Effect.provide(
      MobilePreferences.layer.pipe(
        Layer.provide(Layer.succeed(MobileDatabase.MobileDatabase, database)),
        Layer.provide(Layer.succeed(MobileSecureStorage.MobileSecureStorage, secureStorage)),
      ),
    ),
  );
}

describe("MobilePreferencesStore", () => {
  it.effect("keeps a supported dictation language and drops an unknown one", () =>
    Effect.gen(function* () {
      expect(yield* loadStored({ dictationLanguage: "de-DE" })).toEqual({
        dictationLanguage: "de-DE",
      });
      expect(yield* loadStored({ dictationLanguage: "auto" })).toEqual({
        dictationLanguage: "auto",
      });
      expect(yield* loadStored({ dictationLanguage: "xx-XX", baseFontSize: 16 })).toEqual({
        baseFontSize: 16,
      });
    }),
  );
});
