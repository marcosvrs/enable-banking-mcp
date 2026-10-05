import { randomUUID } from "node:crypto";

export type OnboardingPhase =
  | "starting"
  | "checking_session"
  | "balance_retrieval"
  | "setup"
  | "collecting_input"
  | "application_setup"
  | "application_check"
  | "account_activation"
  | "bank_discovery"
  | "bank_selection"
  | "consent_settings"
  | "bank_authorization"
  | "control_panel_auth"
  | "registering_application"
  | "account_link"
  | "application_ready"
  | "complete"
  | "failed";

export type OnboardingRunStatus = "running" | "awaiting_user" | "failed" | "complete";

export interface OnboardingSnapshot {
  flow_id: string;
  status: OnboardingRunStatus;
  phase: OnboardingPhase;
}

export class OnboardingStateMachine {
  private current?: OnboardingSnapshot;

  begin(): OnboardingSnapshot {
    if (this.current?.status === "running") {
      throw new Error("connect_bank is already in progress");
    }
    const flowId =
      this.current?.status === "awaiting_user"
        ? this.current.flow_id
        : randomUUID();
    this.current = {
      flow_id: flowId,
      status: "running",
      phase: "starting",
    };
    return this.snapshot()!;
  }

  setPhase(flowId: string, phase: OnboardingPhase): void {
    if (this.current?.flow_id !== flowId || this.current.status !== "running") {
      return;
    }
    this.current = { ...this.current, phase };
  }

  awaitUser(flowId: string, phase: OnboardingPhase): void {
    if (this.current?.flow_id !== flowId) return;
    this.current = { ...this.current, status: "awaiting_user", phase };
  }

  fail(flowId: string): void {
    if (this.current?.flow_id !== flowId) return;
    this.current = { ...this.current, status: "failed", phase: "failed" };
  }

  complete(flowId: string): void {
    if (this.current?.flow_id !== flowId) return;
    this.current = { ...this.current, status: "complete", phase: "complete" };
  }

  snapshot(): OnboardingSnapshot | undefined {
    return this.current ? { ...this.current } : undefined;
  }
}
