// Types matching the Rust backend

export type ToolKind = "codex" | "claude";

export type AuthMode = "api_key" | "chat_g_p_t" | "claude_code" | "claude_desktop";

export type ActiveTool = "codex" | "claude_code" | "claude_desktop";

export interface AccountInfo {
  id: string;
  name: string;
  email: string | null;
  plan_type: string | null;
  subscription_expires_at: string | null;
  tool: ToolKind;
  auth_mode: AuthMode;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
}

export interface UsageInfo {
  account_id: string;
  plan_type: string | null;
  primary_used_percent: number | null;
  primary_window_minutes: number | null;
  primary_resets_at: number | null;
  secondary_used_percent: number | null;
  secondary_window_minutes: number | null;
  secondary_resets_at: number | null;
  has_credits: boolean | null;
  unlimited_credits: boolean | null;
  credits_balance: string | null;
  rate_limit_reset_available_count: number | null;
  rate_limit_reset_credits: CodexRateLimitResetCredits | null;
  rate_limit_reset_error: string | null;
  error: string | null;
}

export interface CodexRateLimitResetCredits {
  credits: CodexRateLimitResetCredit[];
  available_count: number;
  total_earned_count: number | null;
}

export interface CodexRateLimitResetCredit {
  reset_type: string | null;
  status: string;
  granted_at: string;
  expires_at: string;
  redeem_started_at: string | null;
  redeemed_at: string | null;
  title: string | null;
  description: string | null;
}

export type CodexRateLimitResetOutcome =
  | "reset"
  | "nothing_to_reset"
  | "no_credit"
  | "already_redeemed";

export interface CodexRateLimitResetConsumeResult {
  outcome: CodexRateLimitResetOutcome;
}

export interface OAuthLoginInfo {
  auth_url: string;
  callback_port: number;
}

export interface AccountWithUsage extends AccountInfo {
  usage?: UsageInfo;
  usageLoading?: boolean;
}

export interface ProcessInfo {
  count: number;
  background_count: number;
  can_switch: boolean;
  pids: number[];
}

export interface WarmupSummary {
  total_accounts: number;
  warmed_accounts: number;
  failed_account_ids: string[];
}

export interface ImportAccountsSummary {
  total_in_payload: number;
  imported_count: number;
  skipped_count: number;
}
