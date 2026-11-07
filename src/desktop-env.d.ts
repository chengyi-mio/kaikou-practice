export {};
export type ServiceConfig = { baseUrl: string; model: string; hasKey: boolean };
export type TrialCheck = { freeTierOnly: true; remainingTokens: number; expiresAt: string; checkedAt: number };
export type RealtimeConfig = { region: string; workspace: string; model: string; hasKey: boolean; trial?: TrialCheck };
export type ServiceInput = {
  baseUrl: string;
  model: string;
  apiKey: string;
  clearKey?: boolean;
};
type Result<T> =
  { success: true; value: T } | { success: false; message: string };
declare global {
  interface Window {
    desktopApp?: {
      platform: string;
      getRealtimeSettings(): Promise<Result<RealtimeConfig>>;
      saveRealtimeSettings(input: Omit<RealtimeConfig, "hasKey"> & { apiKey: string; clearKey?: boolean }): Promise<Result<RealtimeConfig>>;
      getServiceSettings(): Promise<Result<ServiceConfig>>;
      saveServiceSettings(input: ServiceInput): Promise<Result<ServiceConfig>>;
      testServiceSettings(
        input: ServiceInput,
      ): Promise<Result<{ ok: boolean; message: string }>>;
      restart(): Promise<void>;
    };
  }
}
