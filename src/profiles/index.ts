import type { ProfileName } from "../types.ts";

export type ProfileConfig = {
  name: ProfileName;
  vocabulary: string[];
  evidence_expectations: string[];
  risk_defaults: string[];
};

export const profiles: Record<ProfileName, ProfileConfig> = {
  document_strategy: {
    name: "document_strategy",
    vocabulary: ["scope", "contradiction", "missing risk", "decision boundary"],
    evidence_expectations: ["artifact", "event", "note"],
    risk_defaults: ["approval boundary drift", "missing success criteria"],
  },
  research: {
    name: "research",
    vocabulary: ["source", "freshness", "assumption", "data lineage"],
    evidence_expectations: ["source", "artifact", "metric", "note"],
    risk_defaults: ["stale source", "unsupported assumption", "missing data lineage"],
  },
};

export function isSupportedProfile(profile: string): profile is ProfileName {
  return profile === "document_strategy" || profile === "research";
}

export function profileExpectationSummary(profile: ProfileName): string {
  const config = profiles[profile];
  return `${config.name}: evidence=${config.evidence_expectations.join(", ")}; risks=${config.risk_defaults.join(", ")}`;
}
