import { useState, useEffect, useRef, useCallback, useReducer } from "react";

// ─── CONFIGURATION ───────────────────────────────────────────────────────────

const SUPPORT_GROUPS = [
  { id: "infra", name: "Infrastructure & Cloud", icon: "☁️", color: "#0ea5e9", lead: "Priya Sharma", capacity: 12, active: 8, expertise: "AWS, Azure, GCP, Kubernetes, Docker, Terraform, databases, servers, scaling" },
  { id: "security", name: "Security Operations", icon: "🛡️", color: "#f43f5e", lead: "Marcus Chen", capacity: 8, active: 6, expertise: "Threat detection, incident response, vulnerabilities, compliance, access attacks, SIEM" },
  { id: "data", name: "Data Engineering", icon: "📊", color: "#8b5cf6", lead: "Aisha Patel", capacity: 10, active: 7, expertise: "ETL pipelines, data warehouses, Spark, Kafka, analytics, BI dashboards, data quality" },
  { id: "app", name: "Application Support", icon: "⚙️", color: "#f59e0b", lead: "James Wilson", capacity: 15, active: 11, expertise: "Application bugs, deployments, APIs, frontend/backend, mobile apps, performance" },
  { id: "network", name: "Network Operations", icon: "🌐", color: "#10b981", lead: "Elena Rodriguez", capacity: 9, active: 5, expertise: "VPN, DNS, BGP, routing, firewalls, load balancers, CDN, ISP connectivity" },
  { id: "identity", name: "Identity & Access", icon: "🔑", color: "#ec4899", lead: "David Kim", capacity: 7, active: 4, expertise: "SSO, RBAC, provisioning, deprovisioning, MFA, Okta, Active Directory, access reviews" },
];

const PRIORITY_CONFIG = {
  critical: { label: "P1 — Critical", color: "#ef4444", bg: "#fef2f2" },
  high: { label: "P2 — High", color: "#f97316", bg: "#fff7ed" },
  medium: { label: "P3 — Medium", color: "#eab308", bg: "#fefce8" },
  low: { label: "P4 — Low", color: "#22c55e", bg: "#f0fdf4" },
};

const SAMPLE_CASES = [
  { title: "Production database cluster showing high latency", description: "Our primary PostgreSQL cluster on AWS RDS is experiencing 5x normal query latency since 3am. Multiple microservices are affected and customer-facing APIs are timing out. We've already scaled read replicas but the issue persists on the primary writer node." },
  { title: "Suspicious login attempts from unknown IPs", description: "Our SIEM detected 2,400 failed authentication attempts against the employee SSO portal from IP ranges in Eastern Europe over the past hour. Pattern suggests credential stuffing attack. No confirmed breaches yet but the volume is escalating rapidly." },
  { title: "ETL pipeline failing on customer analytics data", description: "The nightly Spark job that processes customer clickstream data from Kafka into our Snowflake warehouse has been failing for 3 consecutive nights. Error logs show schema evolution issues after the recent product catalog update. Marketing team cannot access updated dashboards." },
  { title: "Mobile app crashing on iOS 18 after latest release", description: "After pushing v4.2.1 to the App Store, we're seeing a 340% increase in crash reports specifically on iOS 18 devices. The crash appears to be in the payment checkout flow. Sentry logs point to a null pointer in the new Apple Pay integration module." },
  { title: "VPN tunnel between HQ and Tokyo office is down", description: "The IPSec tunnel between our headquarters and Tokyo satellite office dropped at 06:00 UTC. Tokyo employees (230 staff) cannot access internal resources. BGP sessions show the peer as unreachable. ISP says no outage on their end." },
  { title: "Former contractor still has access to staging environment", description: "During quarterly access review, we discovered that a contractor whose engagement ended 45 days ago still has active credentials to our staging Kubernetes cluster and CI/CD pipeline. The contractor had elevated permissions for deployment operations." },
];

// ─── LLM CLASSIFICATION ENGINE ───────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert IT support case classification agent. Your job is to analyze incoming support tickets and produce a structured classification.

AVAILABLE SUPPORT GROUPS:
${SUPPORT_GROUPS.map(g => `- "${g.id}": ${g.name} — Expertise: ${g.expertise}`).join("\n")}

PRIORITY LEVELS:
- "critical": Production down, security breach active, data loss imminent, widespread customer impact
- "high": Significant degradation, security threat escalating, major feature broken, large user group affected  
- "medium": Non-critical failure, scheduled review findings, limited user impact, workaround available
- "low": Minor issue, cosmetic bug, feature request, informational inquiry

You MUST respond with ONLY a valid JSON object (no markdown, no backticks, no preamble) with this exact schema:
{
  "assigned_group": "<group_id>",
  "priority": "<critical|high|medium|low>",
  "confidence": <0.0 to 1.0>,
  "reasoning": "<2-3 sentence explanation of WHY this group and priority were chosen>",
  "entities": [{"type": "<Technology|Service|Metric|Location|Person|TimeRef>", "value": "<extracted value>"}],
  "keywords": ["<relevant technical terms extracted>"],
  "risk_factors": ["<identified risks or escalation triggers>"],
  "suggested_actions": ["<immediate recommended actions>"],
  "sentiment": "<urgent|frustrated|neutral|informational>",
  "estimated_complexity": "<simple|moderate|complex|critical_complex>",
  "secondary_group": "<group_id or null if not applicable — suggest if cross-team collaboration needed>"
}`;

async function classifyWithLLM(title, description) {
  const response = await fetch("/api/classify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      description,
      systemPrompt: SYSTEM_PROMPT
    }),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error?.message || 'Classification failed');
  }

  const data = await response.json();
  const text = data.content?.map(b => b.text || "").join("") || "";
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── STATE ───────────────────────────────────────────────────────────────────

const initialState = {
  cases: [],
  activeCase: null,
  agentSteps: [],
  agentPhase: "idle",
  stats: { total: 0, avgConfidence: 0, byGroup: {}, byPriority: {} },
  view: "ingest",
  error: null,
};

function reducer(state, action) {
  switch (action.type) {
    case "SET_VIEW": return { ...state, view: action.payload };
    case "RESET_AGENT": return { ...state, agentSteps: [], agentPhase: "idle", activeCase: null, error: null };
    case "START": return { ...state, agentPhase: "running", agentSteps: [], activeCase: action.payload, error: null };
    case "STEP": return { ...state, agentSteps: [...state.agentSteps, action.payload] };
    case "PHASE": return { ...state, agentPhase: action.payload };
    case "ERROR": return { ...state, agentPhase: "error", error: action.payload };
    case "COMPLETE": {
      const c = action.payload;
      const cases = [c, ...state.cases];
      const avgConf = cases.reduce((s, x) => s + (x.result?.confidence || 0), 0) / cases.length;
      const byGroup = {};
      const byPriority = {};
      cases.forEach(x => {
        if (x.result) {
          byGroup[x.result.assigned_group] = (byGroup[x.result.assigned_group] || 0) + 1;
          byPriority[x.result.priority] = (byPriority[x.result.priority] || 0) + 1;
        }
      });
      return { ...state, cases, activeCase: c, agentPhase: "complete", stats: { total: cases.length, avgConfidence: avgConf, byGroup, byPriority } };
    }
    case "OVERRIDE": {
      const { caseId, newGroup } = action.payload;
      const cases = state.cases.map(c =>
        c.id === caseId ? { ...c, result: { ...c.result, assigned_group: newGroup }, overridden: true } : c
      );
      const ac = state.activeCase?.id === caseId ? { ...state.activeCase, result: { ...state.activeCase.result, assigned_group: newGroup }, overridden: true } : state.activeCase;
      return { ...state, cases, activeCase: ac };
    }
    default: return state;
  }
}

// ─── HELPER COMPONENTS ───────────────────────────────────────────────────────

const Pulse = ({ color = "#3b82f6", size = 8 }) => (
  <span style={{
    display: "inline-block", width: size, height: size, borderRadius: "50%",
    background: color, boxShadow: `0 0 ${size * 1.5}px ${color}80`,
    animation: "pulse 1.4s ease-in-out infinite",
  }} />
);

const Tag = ({ children, color, bg, mono }) => (
  <span style={{
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600,
    letterSpacing: "0.02em", color, background: bg || `${color}15`,
    border: `1px solid ${color}25`,
    fontFamily: mono ? "'JetBrains Mono', 'IBM Plex Mono', monospace" : "inherit",
  }}>{children}</span>
);

const Ring = ({ value, size = 52, stroke = 3.5, color }) => {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1e293b" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={c} strokeDashoffset={c - (value / 100) * c} strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.8s cubic-bezier(.4,0,.2,1)" }} />
      <text x={size / 2} y={size / 2} textAnchor="middle" dy=".35em" fill={color}
        style={{ fontSize: 12, fontWeight: 700, transform: "rotate(90deg)", transformOrigin: "center" }}>
        {value}%
      </text>
    </svg>
  );
};

const Spinner = () => (
  <span style={{
    display: "inline-block", width: 16, height: 16, border: "2px solid #334155",
    borderTopColor: "#3b82f6", borderRadius: "50%", animation: "spin 0.7s linear infinite",
  }} />
);

// ─── MAIN APP ────────────────────────────────────────────────────────────────

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const logRef = useRef(null);
  const startTime = useRef(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [state.agentSteps]);

  const addStep = (icon, text, type = "info") => {
    dispatch({ type: "STEP", payload: { icon, text, type, time: Date.now() - startTime.current } });
  };

  const runAgent = useCallback(async (caseTitle, caseDesc) => {
    const id = `CS-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    const caseObj = { id, title: caseTitle, description: caseDesc, createdAt: new Date() };
    startTime.current = Date.now();

    dispatch({ type: "START", payload: caseObj });
    dispatch({ type: "SET_VIEW", payload: "agent" });

    // Step 1: Ingest
    addStep("📥", "Case received — ingesting into classification pipeline...");
    await sleep(400);

    // Step 2: Pre-processing
    addStep("🔤", `Tokenizing input: ${caseTitle.split(" ").length + caseDesc.split(" ").length} words across title and description`);
    await sleep(300);

    // Step 3: LLM call
    addStep("🧠", "Sending to Azure OpenAI LLM for deep semantic analysis...", "llm");
    await sleep(200);

    try {
      const result = await classifyWithLLM(caseTitle, caseDesc);
      const elapsed = Date.now() - startTime.current;

      // Step 4: Response received
      addStep("✅", `LLM response received in ${elapsed}ms — parsing structured output...`);
      await sleep(250);

      // Step 5: Validation
      const grp = SUPPORT_GROUPS.find(g => g.id === result.assigned_group);
      if (!grp) {
        addStep("⚠️", `Unknown group "${result.assigned_group}" — falling back to Application Support`, "warn");
        result.assigned_group = "app";
      }
      addStep("🔍", `Classification: ${SUPPORT_GROUPS.find(g => g.id === result.assigned_group)?.name} | Priority: ${result.priority} | Confidence: ${(result.confidence * 100).toFixed(0)}%`);
      await sleep(200);

      // Step 6: Sentiment & complexity
      addStep("💬", `Sentiment: ${result.sentiment || "neutral"} | Complexity: ${result.estimated_complexity || "moderate"}`);
      await sleep(150);

      // Step 7: Entity extraction results
      if (result.entities?.length > 0) {
        addStep("🏷️", `Extracted ${result.entities.length} entities: ${result.entities.map(e => e.value).join(", ")}`);
        await sleep(150);
      }

      // Step 8: Risk factors
      if (result.risk_factors?.length > 0) {
        addStep("⚠️", `Risk factors identified: ${result.risk_factors.join("; ")}`, "warn");
        await sleep(150);
      }

      // Step 9: Secondary group
      if (result.secondary_group && result.secondary_group !== "null") {
        const sec = SUPPORT_GROUPS.find(g => g.id === result.secondary_group);
        if (sec) addStep("🤝", `Cross-team collaboration suggested with ${sec.name}`);
        await sleep(150);
      }

      // Step 10: Assignment
      const assignedGroup = SUPPORT_GROUPS.find(g => g.id === result.assigned_group);
      const available = assignedGroup.capacity - assignedGroup.active;
      addStep("🎯", `Assigning to ${assignedGroup.lead} (${assignedGroup.name}) — ${available} agents available`);
      await sleep(200);

      addStep("🏁", `Pipeline complete in ${Date.now() - startTime.current}ms — case ${id} is now routed`, "success");

      dispatch({ type: "COMPLETE", payload: { ...caseObj, result, elapsedMs: Date.now() - startTime.current } });

    } catch (err) {
      addStep("❌", `LLM Error: ${err.message}`, "error");
      dispatch({ type: "ERROR", payload: err.message });
    }
  }, []);

  const handleSubmit = () => {
    if (title.trim() && desc.trim()) {
      runAgent(title, desc);
      setTitle("");
      setDesc("");
    }
  };

  // ─── THEME ─────────────────────────────────────────────────────────────────

  const T = {
    bg: "#06090f", s1: "#0d1117", s2: "#161b22", s3: "#1c2333",
    b1: "#1e293b", b2: "#30364a",
    t1: "#e6edf3", t2: "#8b949e", t3: "#484f58",
    accent: "#58a6ff", accentBg: "#58a6ff12",
    green: "#3fb950", red: "#f85149", yellow: "#d29922", purple: "#bc8cff",
  };

  const S = {
    app: { fontFamily: "'Inter', 'SF Pro Text', -apple-system, sans-serif", background: T.bg, color: T.t1, minHeight: "100vh", display: "flex", flexDirection: "column" },
    header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: `1px solid ${T.b1}`, background: T.s1 },
    card: { background: T.s1, border: `1px solid ${T.b1}`, borderRadius: 10 },
    input: { width: "100%", padding: "10px 14px", borderRadius: 8, border: `1px solid ${T.b1}`, background: T.bg, color: T.t1, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" },
    textarea: { width: "100%", padding: "10px 14px", borderRadius: 8, border: `1px solid ${T.b1}`, background: T.bg, color: T.t1, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box", resize: "vertical", minHeight: 90 },
    btnPrimary: { padding: "9px 20px", borderRadius: 8, border: "none", background: `linear-gradient(135deg, #2563eb, #7c3aed)`, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6 },
    btnGhost: { padding: "6px 12px", borderRadius: 6, border: `1px solid ${T.b1}`, background: "transparent", color: T.t2, fontSize: 11, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s" },
    navBtn: (active) => ({ padding: "7px 14px", borderRadius: 7, border: "none", background: active ? T.accentBg : "transparent", color: active ? T.accent : T.t2, fontSize: 12.5, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s" }),
  };

  // ─── VIEWS ─────────────────────────────────────────────────────────────────

  const renderIngest = () => (
    <div style={{ maxWidth: 900, margin: "0 auto", width: "100%" }}>
      {/* LLM Badge */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, padding: "12px 16px", borderRadius: 10, background: `linear-gradient(135deg, ${T.purple}08, ${T.accent}08)`, border: `1px solid ${T.purple}20` }}>
        <span style={{ fontSize: 20 }}>🧠</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.purple }}>Powered by Claude LLM</div>
          <div style={{ fontSize: 11, color: T.t2 }}>Each case is analyzed by Claude Sonnet for semantic classification, entity extraction, risk assessment, and intelligent routing — not keyword matching.</div>
        </div>
      </div>

      {/* Custom Form */}
      <div style={{ ...S.card, padding: 22, marginBottom: 24 }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Submit a Support Case</div>
        <div style={{ fontSize: 12, color: T.t2, marginBottom: 16 }}>The AI agent will analyze the full semantic context, not just keywords.</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input style={S.input} placeholder="Case title..." value={title} onChange={e => setTitle(e.target.value)} />
          <textarea style={S.textarea} placeholder="Describe the issue in detail — include affected systems, symptoms, timeline, impact scope..." value={desc} onChange={e => setDesc(e.target.value)} rows={4} />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button style={{ ...S.btnPrimary, opacity: title && desc ? 1 : 0.4 }} onClick={handleSubmit} disabled={!title || !desc || state.agentPhase === "running"}>
              {state.agentPhase === "running" ? <><Spinner /> Classifying...</> : <>🚀 Classify with Claude</>}
            </button>
          </div>
        </div>
      </div>

      {/* Samples */}
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Sample Cases</div>
      <div style={{ fontSize: 12, color: T.t2, marginBottom: 14 }}>Click to send through the LLM pipeline</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {SAMPLE_CASES.map((sc, i) => (
          <div key={i} style={{ ...S.card, padding: 16, cursor: state.agentPhase === "running" ? "not-allowed" : "pointer", opacity: state.agentPhase === "running" ? 0.5 : 1, transition: "all 0.15s" }}
            onClick={() => state.agentPhase !== "running" && runAgent(sc.title, sc.description)}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>{sc.title}</div>
            <div style={{ fontSize: 11, color: T.t2, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{sc.description}</div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderAgent = () => {
    const c = state.activeCase;
    const r = c?.result;
    const grp = r ? SUPPORT_GROUPS.find(g => g.id === r.assigned_group) : null;
    const pri = r ? PRIORITY_CONFIG[r.priority] : null;
    const secGrp = r?.secondary_group && r.secondary_group !== "null" ? SUPPORT_GROUPS.find(g => g.id === r.secondary_group) : null;

    return (
      <div style={{ display: "flex", gap: 20, height: "calc(100vh - 56px)" }}>
        {/* Left: Agent Log */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexShrink: 0 }}>
            <Pulse color={state.agentPhase === "complete" ? T.green : state.agentPhase === "error" ? T.red : T.accent} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>Agent Pipeline</span>
            <span style={{ fontSize: 11, color: T.t3, marginLeft: "auto" }}>
              {state.agentPhase === "complete" ? "✓ Done" : state.agentPhase === "error" ? "✗ Error" : state.agentPhase === "running" ? "Processing..." : "Idle"}
            </span>
          </div>

          <div ref={logRef} style={{ ...S.card, flex: 1, overflow: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 3 }}>
            {state.agentSteps.map((step, i) => (
              <div key={i} style={{
                padding: "9px 12px", borderRadius: 7, fontSize: 12.5, lineHeight: 1.5,
                background: step.type === "error" ? `${T.red}10` : step.type === "success" ? `${T.green}08` : step.type === "llm" ? `${T.purple}08` : "transparent",
                borderLeft: `2px solid ${step.type === "error" ? T.red : step.type === "success" ? T.green : step.type === "warn" ? T.yellow : step.type === "llm" ? T.purple : T.b1}`,
                color: step.type === "error" ? T.red : T.t1,
                animation: "fadeIn 0.25s ease",
              }}>
                <span style={{ marginRight: 6 }}>{step.icon}</span>
                {step.text}
                <span style={{ float: "right", fontSize: 10, color: T.t3, fontFamily: "'JetBrains Mono', monospace" }}>{step.time}ms</span>
              </div>
            ))}
            {state.agentPhase === "running" && (
              <div style={{ padding: "9px 12px", display: "flex", alignItems: "center", gap: 8, color: T.t2, fontSize: 12 }}>
                <Spinner /> Waiting for agent response...
              </div>
            )}
          </div>
        </div>

        {/* Right: Results Panel */}
        <div style={{ width: 380, overflow: "auto", display: "flex", flexDirection: "column", gap: 14, flexShrink: 0 }}>
          {/* Case Info */}
          {c && (
            <div style={{ ...S.card, padding: 16 }}>
              <div style={{ fontSize: 10, color: T.t3, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Case {c.id}</div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{c.title}</div>
              <div style={{ fontSize: 11.5, color: T.t2, lineHeight: 1.6 }}>{c.description}</div>
            </div>
          )}

          {/* Classification Result */}
          {r && (
            <>
              <div style={{ ...S.card, padding: 16, borderColor: `${grp.color}30`, background: `linear-gradient(135deg, ${grp.color}06, ${T.s1})` }}>
                <div style={{ fontSize: 10, color: T.t3, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>LLM Classification Result</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <div>
                    <div style={{ fontSize: 10, color: T.t3, marginBottom: 3 }}>ASSIGNED GROUP</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: grp.color }}>{grp.icon} {grp.name}</div>
                    {c.overridden && <Tag color={T.yellow} mono>overridden</Tag>}
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: T.t3, marginBottom: 3 }}>PRIORITY</div>
                    <Tag color={pri.color} bg={pri.bg}>{pri.label}</Tag>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: T.t3, marginBottom: 3 }}>CONFIDENCE</div>
                    <Ring value={Math.round(r.confidence * 100)} size={46} stroke={3} color={r.confidence > 0.85 ? T.green : r.confidence > 0.65 ? T.yellow : T.red} />
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: T.t3, marginBottom: 3 }}>PROCESSING</div>
                    <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{c.elapsedMs}ms</div>
                  </div>
                </div>
                {secGrp && (
                  <div style={{ marginTop: 12, padding: "8px 12px", borderRadius: 6, background: `${secGrp.color}10`, border: `1px solid ${secGrp.color}20`, fontSize: 11 }}>
                    🤝 Cross-team: <span style={{ color: secGrp.color, fontWeight: 600 }}>{secGrp.icon} {secGrp.name}</span>
                  </div>
                )}
              </div>

              {/* LLM Reasoning */}
              <div style={{ ...S.card, padding: 16 }}>
                <div style={{ fontSize: 10, color: T.t3, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>🧠 LLM Reasoning</div>
                <div style={{ fontSize: 12, color: T.t1, lineHeight: 1.7, fontStyle: "italic", borderLeft: `2px solid ${T.purple}`, paddingLeft: 12 }}>
                  "{r.reasoning}"
                </div>
              </div>

              {/* Entities */}
              {r.entities?.length > 0 && (
                <div style={{ ...S.card, padding: 16 }}>
                  <div style={{ fontSize: 10, color: T.t3, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Extracted Entities</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {r.entities.map((e, i) => (
                      <Tag key={i} color={T.accent} mono>
                        <span style={{ color: T.t3, fontWeight: 400 }}>{e.type}:</span> {e.value}
                      </Tag>
                    ))}
                  </div>
                </div>
              )}

              {/* Risk Factors */}
              {r.risk_factors?.length > 0 && (
                <div style={{ ...S.card, padding: 16 }}>
                  <div style={{ fontSize: 10, color: T.t3, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>⚠️ Risk Factors</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {r.risk_factors.map((rf, i) => (
                      <div key={i} style={{ fontSize: 12, color: T.yellow, padding: "5px 10px", borderRadius: 5, background: `${T.yellow}08`, borderLeft: `2px solid ${T.yellow}` }}>
                        {rf}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Suggested Actions */}
              {r.suggested_actions?.length > 0 && (
                <div style={{ ...S.card, padding: 16 }}>
                  <div style={{ fontSize: 10, color: T.t3, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Suggested Actions</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {r.suggested_actions.map((a, i) => (
                      <div key={i} style={{ fontSize: 12, color: T.green, padding: "5px 10px", borderRadius: 5, background: `${T.green}08`, borderLeft: `2px solid ${T.green}` }}>
                        {a}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Keywords */}
              {r.keywords?.length > 0 && (
                <div style={{ ...S.card, padding: 16 }}>
                  <div style={{ fontSize: 10, color: T.t3, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Signal Keywords</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {r.keywords.map((k, i) => (
                      <span key={i} style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10.5, background: T.s3, color: T.t2, fontFamily: "'JetBrains Mono', monospace" }}>{k}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Override */}
              <div style={{ ...S.card, padding: 16 }}>
                <div style={{ fontSize: 10, color: T.t3, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Manual Override</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {SUPPORT_GROUPS.filter(g => g.id !== r.assigned_group).map(g => (
                    <button key={g.id} style={S.btnGhost}
                      onClick={() => dispatch({ type: "OVERRIDE", payload: { caseId: c.id, newGroup: g.id } })}>
                      {g.icon} {g.name}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {!c && (
            <div style={{ ...S.card, padding: 40, textAlign: "center" }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>🤖</div>
              <div style={{ fontSize: 13, color: T.t2 }}>Submit a case to begin</div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderDashboard = () => (
    <div style={{ maxWidth: 900, margin: "0 auto", width: "100%" }}>
      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
        {[
          { label: "Total Classified", value: state.stats.total, icon: "📋", color: T.accent },
          { label: "Avg Confidence", value: state.stats.total ? `${(state.stats.avgConfidence * 100).toFixed(0)}%` : "—", icon: "🎯", color: T.green },
          { label: "Groups Active", value: SUPPORT_GROUPS.length, icon: "👥", color: T.purple },
        ].map((s, i) => (
          <div key={i} style={{ ...S.card, padding: 18 }}>
            <div style={{ fontSize: 10, color: T.t3, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>{s.label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Distribution */}
      {state.stats.total > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 24 }}>
          <div style={{ ...S.card, padding: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 12 }}>By Group</div>
            {SUPPORT_GROUPS.map(g => {
              const count = state.stats.byGroup[g.id] || 0;
              const pct = state.stats.total ? (count / state.stats.total) * 100 : 0;
              return (
                <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 14, width: 22 }}>{g.icon}</span>
                  <span style={{ fontSize: 11, color: T.t2, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</span>
                  <div style={{ width: 80, height: 6, borderRadius: 3, background: T.b1, overflow: "hidden" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: g.color, borderRadius: 3, transition: "width 0.5s" }} />
                  </div>
                  <span style={{ fontSize: 11, color: T.t3, width: 20, textAlign: "right" }}>{count}</span>
                </div>
              );
            })}
          </div>
          <div style={{ ...S.card, padding: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 12 }}>By Priority</div>
            {Object.entries(PRIORITY_CONFIG).map(([key, cfg]) => {
              const count = state.stats.byPriority[key] || 0;
              const pct = state.stats.total ? (count / state.stats.total) * 100 : 0;
              return (
                <div key={key} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <Tag color={cfg.color} bg={cfg.bg}>{cfg.label}</Tag>
                  <div style={{ flex: 1, height: 6, borderRadius: 3, background: T.b1, overflow: "hidden" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: cfg.color, borderRadius: 3, transition: "width 0.5s" }} />
                  </div>
                  <span style={{ fontSize: 11, color: T.t3, width: 20, textAlign: "right" }}>{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* History */}
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Classification History</div>
      {state.cases.length === 0 ? (
        <div style={{ ...S.card, padding: 40, textAlign: "center", color: T.t3 }}>No cases classified yet. Go to Ingest to submit one.</div>
      ) : (
        <div style={S.card}>
          {state.cases.map((c, i) => {
            const grp = SUPPORT_GROUPS.find(g => g.id === c.result?.assigned_group);
            const pri = PRIORITY_CONFIG[c.result?.priority];
            return (
              <div key={c.id} style={{
                padding: "12px 16px", borderBottom: i < state.cases.length - 1 ? `1px solid ${T.b1}` : "none",
                cursor: "pointer", transition: "background 0.1s",
              }} onClick={() => { dispatch({ type: "COMPLETE", payload: c }); dispatch({ type: "SET_VIEW", payload: "agent" }); }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, flex: 1, marginRight: 10 }}>{c.title}</div>
                  <Tag color={pri?.color} bg={pri?.bg}>{pri?.label}</Tag>
                </div>
                <div style={{ display: "flex", gap: 12, fontSize: 11, color: T.t2, alignItems: "center" }}>
                  <span style={{ color: grp?.color }}>{grp?.icon} {grp?.name}</span>
                  <span style={{ color: T.t3 }}>•</span>
                  <span>{(c.result?.confidence * 100).toFixed(0)}% conf</span>
                  <span style={{ color: T.t3 }}>•</span>
                  <span style={{ fontFamily: "monospace" }}>{c.elapsedMs}ms</span>
                  {c.overridden && <Tag color={T.yellow}>overridden</Tag>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  // ─── RENDER ────────────────────────────────────────────────────────────────

  return (
    <div style={S.app}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #30364a; border-radius: 3px; }
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.35 } }
        @keyframes spin { to { transform: rotate(360deg) } }
        @keyframes fadeIn { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:none } }
        input::placeholder, textarea::placeholder { color: #484f58; }
      `}</style>

      {/* Header */}
      <div style={S.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg, #2563eb, #7c3aed)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, color: "#fff" }}>AI</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-0.01em" }}>Case Classification Agent</div>
            <div style={{ fontSize: 10, color: T.t3 }}>LLM-Powered • Claude Sonnet</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 3 }}>
          {[
            { id: "ingest", label: "📥 Ingest" },
            { id: "agent", label: "🤖 Agent" },
            { id: "dashboard", label: "📊 Dashboard" },
          ].map(v => (
            <button key={v.id} style={S.navBtn(state.view === v.id)} onClick={() => dispatch({ type: "SET_VIEW", payload: v.id })}>
              {v.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Pulse color={T.green} />
          <span style={{ fontSize: 11, color: T.t3 }}>Agent Online</span>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
        {state.view === "ingest" && renderIngest()}
        {state.view === "agent" && renderAgent()}
        {state.view === "dashboard" && renderDashboard()}
      </div>
    </div>
  );
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
