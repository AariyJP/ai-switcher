// Types matching the Rust backend

export type ToolKind = "codex" | "claude" | "cursor";

export type AuthMode =
  | "api_key"
  | "chat_g_p_t"
  | "claude_code"
  | "claude_desktop"
  | "cursor";

export type ActiveTool = "codex" | "claude_code" | "claude_desktop" | "cursor";

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

export interface ScopedLimit {
  used_percent: number;
  window_minutes: number | null;
  resets_at: number | null;
  label: string | null;
}

export interface CursorUsageDetails {
  total_used_percent: number | null;
  auto_composer_used_percent: number | null;
  api_used_percent: number | null;
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
  scoped_limits: ScopedLimit[];
  has_credits: boolean | null;
  unlimited_credits: boolean | null;
  credits_balance: string | null;
  rate_limit_reset_available_count: number | null;
  rate_limit_reset_credits: CodexRateLimitResetCredits | null;
  rate_limit_reset_error: string | null;
  cursor_usage?: CursorUsageDetails | null;
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

export interface AccountUsageSummary {
  lifetime_tokens: number | null;
  peak_daily_tokens: number | null;
  longest_task_seconds: number | null;
  current_streak_days: number | null;
  longest_streak_days: number | null;
}

export interface AccountUsageActivity {
  fast_mode_percent: number | null;
  reasoning_effort: string | null;
  reasoning_effort_percent: number | null;
  skills_explored: number | null;
  total_skills_used: number | null;
  total_threads: number | null;
}

export interface AccountDailyUsage {
  date: string;
  tokens: number;
}

export interface AccountTopInvocation {
  kind: string;
  display_name: string;
  usage_count: number;
  plugin_id: string | null;
  plugin_name: string | null;
  skill_id: string | null;
  skill_name: string | null;
}

export interface AccountResetCredit {
  id: string;
  reset_type: string;
  status: string;
  granted_at: string | null;
  expires_at: string | null;
  redeem_started_at: string | null;
  redeemed_at: string | null;
  title: string | null;
  description: string | null;
}

export interface AccountResetCredits {
  available_count: number;
  next_expires_at: string | null;
  credits: AccountResetCredit[];
}

export interface AccountUsageStats {
  account_id: string;
  available: boolean;
  source: string;
  generated_at: string | null;
  stats_as_of: string | null;
  summary: AccountUsageSummary;
  activity: AccountUsageActivity;
  daily: AccountDailyUsage[];
  top_invocations: AccountTopInvocation[];
  reset_credits: AccountResetCredits | null;
  error: string | null;
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
