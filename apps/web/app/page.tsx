"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addEdge,
  Background,
  Connection,
  Controls,
  Edge,
  MiniMap,
  Node,
  OnConnect,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState
} from "reactflow";
import "reactflow/dist/style.css";
import { DEFAULT_CANVAS_ID } from "@frame2/shared";

type FlowNodeData = {
  label?: string;
  nodeType: string;
  config: Record<string, unknown>;
  status?: Record<string, unknown>;
};

type FlowNode = Node<FlowNodeData>;

type RenderItem = {
  id: string;
  gridIndex: number;
  createdAt: string;
  promptSnapshot: Record<string, unknown>;
  asset: {
    id: string;
    url: string;
    mime: string;
  };
};

type AnalysisReport = {
  continuity: number;
  coverage: number;
  promptStrength: number;
  notes: string[];
  evidence: Array<{ key: string; value: string }>;
};

function buildAnalysisReport(
  renders: RenderItem[],
  selectedConfig: Record<string, unknown>
): AnalysisReport {
  const target = Math.max(1, Number(selectedConfig.rows ?? 3) * Number(selectedConfig.cols ?? 3));
  const coverage = Math.min(100, Math.round((renders.length / target) * 100));
  const continuityBase = Boolean(selectedConfig.continuity ?? true) ? 68 : 42;
  const continuity = Math.min(98, continuityBase + Math.min(24, renders.length * 3));
  const promptText = String(selectedConfig.prompt ?? "");
  const promptStrength = Math.min(100, Math.max(20, Math.round(promptText.length * 1.6)));

  const notes: string[] = [];
  if (coverage < 100) notes.push("Grid coverage is incomplete; run or re-run to fill missing cells.");
  if (continuity < 80) notes.push("Continuity signal is weak; keep CONTINUITY ON and run follow-up batches.");
  if (promptStrength < 65) notes.push("Prompt is short; add camera movement, lens, and composition constraints.");
  if (notes.length === 0) notes.push("Current node is stable for next continuity iteration.");

  const evidence = [
    { key: "target_grid", value: `${target}` },
    { key: "actual_renders", value: `${renders.length}` },
    { key: "continuity_enabled", value: Boolean(selectedConfig.continuity ?? true) ? "true" : "false" },
    { key: "prompt_length", value: `${promptText.length}` }
  ];

  return { continuity, coverage, promptStrength, notes, evidence };
}

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
const canvasId = process.env.NEXT_PUBLIC_DEFAULT_CANVAS_ID ?? DEFAULT_CANVAS_ID;

function Workbench() {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [canvasVersion, setCanvasVersion] = useState(0);
  const [canvasName, setCanvasName] = useState("Main Canvas");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [renders, setRenders] = useState<RenderItem[]>([]);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [executionStatus, setExecutionStatus] = useState("IDLE");
  const [exportId, setExportId] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string>("IDLE");
  const [exportDownloadUrl, setExportDownloadUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<"NODE" | "GRAPH" | "CONTINUITY">("NODE");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [inspectorTab, setInspectorTab] = useState<"PROPERTIES" | "AI_ANALYSIS">("PROPERTIES");
  const [selectedRenderId, setSelectedRenderId] = useState<string | null>(null);
  const [renderSort, setRenderSort] = useState<"createdAt:desc" | "createdAt:asc">("createdAt:desc");
  const [renderLimit, setRenderLimit] = useState(24);
  const [renderExecutionFilter, setRenderExecutionFilter] = useState<string>("");
  const [highResByRender, setHighResByRender] = useState<
    Record<string, { status: string; downloadUrl?: string; jobId?: string }>
  >({});

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId),
    [nodes, selectedNodeId]
  );
  const selectedConfig = (selectedNode?.data.config ?? {}) as Record<string, unknown>;
  const selectedRender = useMemo(
    () => renders.find((render) => render.id === selectedRenderId) ?? renders[0] ?? null,
    [renders, selectedRenderId]
  );
  const selectedHighRes = selectedRender ? highResByRender[selectedRender.id] : undefined;
  const analysis = useMemo(() => buildAnalysisReport(renders, selectedConfig), [renders, selectedConfig]);

  const toFlowNode = useCallback((node: any): FlowNode => {
    return {
      id: node.id,
      position: { x: node.x, y: node.y },
      data: {
        label: `${node.type} · ${(node.status?.state as string) ?? "IDLE"}`,
        nodeType: node.type,
        config: node.config ?? {},
        status: node.status ?? {}
      },
      style: { width: 220, background: "#0f172a", border: "1px solid #334155", color: "#e2e8f0" },
      type: "default"
    };
  }, []);

  const appendLog = useCallback((text: string) => {
    setLogLines((prev) => [...prev.slice(-14), `${new Date().toLocaleTimeString()} ${text}`]);
  }, []);

  const fetchCanvas = useCallback(async () => {
    const response = await fetch(`${apiBase}/v1/canvases/${canvasId}`);
    if (!response.ok) throw new Error("Failed to load canvas");
    const payload = await response.json();

    setCanvasName(payload.name);
    setCanvasVersion(payload.version);
    setNodes(payload.nodes.map(toFlowNode));
    setEdges(
      payload.edges.map((edge: any) => ({
        id: edge.id,
        source: edge.fromNodeId,
        target: edge.toNodeId,
        label: edge.type
      }))
    );
  }, [setEdges, setNodes, toFlowNode]);

  const fetchNodeRenders = useCallback(async (nodeId: string) => {
    const query = new URLSearchParams();
    query.set("limit", String(renderLimit));
    query.set("offset", "0");
    query.set("sort", renderSort);
    if (renderExecutionFilter) query.set("executionId", renderExecutionFilter);

    const response = await fetch(`${apiBase}/v1/nodes/${nodeId}/renders?${query.toString()}`);
    if (!response.ok) return;
    const payload = await response.json();
    setRenders(payload);
  }, [renderExecutionFilter, renderLimit, renderSort]);

  useEffect(() => {
    fetchCanvas().catch((error) => appendLog(`Canvas load failed: ${error.message}`));
  }, [appendLog, fetchCanvas]);

  useEffect(() => {
    if (!selectedNodeId) {
      setRenders([]);
      setSelectedRenderId(null);
      return;
    }
    fetchNodeRenders(selectedNodeId).catch((error) => appendLog(`Render load failed: ${error.message}`));
  }, [appendLog, fetchNodeRenders, selectedNodeId]);

  useEffect(() => {
    if (renders.length === 0) {
      setSelectedRenderId(null);
      return;
    }
    if (!selectedRenderId || !renders.some((render) => render.id === selectedRenderId)) {
      const firstRender = renders[0];
      if (firstRender) setSelectedRenderId(firstRender.id);
    }
  }, [renders, selectedRenderId]);

  useEffect(() => {
    if (!selectedRender) return;
    fetch(`${apiBase}/v1/renders/${selectedRender.id}/highres/status`)
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json();
      })
      .then((payload) => {
        if (!payload) return;
        setHighResByRender((prev) => ({
          ...prev,
          [selectedRender.id]: {
            status: String(payload.status ?? "NOT_REQUESTED"),
            downloadUrl: payload.downloadUrl ? `${apiBase}${String(payload.downloadUrl)}` : undefined,
            jobId: payload.jobId ? String(payload.jobId) : undefined
          }
        }));
      })
      .catch(() => {});
  }, [selectedRender]);

  useEffect(() => {
    const eventSource = new EventSource(`${apiBase}/v1/events?canvasId=${canvasId}`);
    eventSource.addEventListener("canvas", async (rawEvent) => {
      const event = JSON.parse((rawEvent as MessageEvent).data) as {
        type: string;
        payload: Record<string, unknown>;
      };

      if (event.type === "execution.updated") {
        const status = String(event.payload.status ?? "UNKNOWN");
        setExecutionStatus(status);
        appendLog(`Execution ${String(event.payload.executionId)} => ${status}`);
      }

      if (event.type === "job.updated") {
        const attempt = event.payload.attempt ? ` attempt=${String(event.payload.attempt)}` : "";
        const maxAttempt = event.payload.maxAttempt ? `/${String(event.payload.maxAttempt)}` : "";
        appendLog(`Job ${String(event.payload.jobId)} => ${String(event.payload.status)}${attempt}${maxAttempt}`);
      }

      if (event.type === "render.created") {
        const nodeId = String(event.payload.nodeId ?? "");
        if (nodeId && nodeId === selectedNodeId) {
          await fetchNodeRenders(nodeId);
        }
      }

      if (event.type === "highres.updated") {
        const renderId = String(event.payload.renderId ?? "");
        if (renderId) {
          setHighResByRender((prev) => ({
            ...prev,
            [renderId]: {
              status: String(event.payload.status ?? "UNKNOWN"),
              jobId: event.payload.jobId ? String(event.payload.jobId) : prev[renderId]?.jobId,
              downloadUrl: event.payload.downloadUrl ? `${apiBase}${String(event.payload.downloadUrl)}` : prev[renderId]?.downloadUrl
            }
          }));
        }
        appendLog(`HighRes ${renderId || "-"} => ${String(event.payload.status ?? "UNKNOWN")}`);
      }

      if (event.type === "node.updated") {
        await fetchCanvas();
      }

      if (event.type === "export.updated") {
        setExportId(String(event.payload.exportId));
        setExportStatus(String(event.payload.status ?? "UNKNOWN"));
        if (event.payload.downloadUrl) {
          setExportDownloadUrl(`${apiBase}${String(event.payload.downloadUrl)}`);
        }
        appendLog(`Export ${String(event.payload.exportId)} => ${String(event.payload.status)}`);
      }
    });

    eventSource.addEventListener("error", () => {
      appendLog("SSE disconnected, retrying...");
    });

    return () => eventSource.close();
  }, [appendLog, fetchCanvas, fetchNodeRenders, selectedNodeId]);

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      setEdges((currentEdges) => addEdge(connection, currentEdges));
    },
    [setEdges]
  );

  const addRenderNode = useCallback(async () => {
    const response = await fetch(`${apiBase}/v1/canvases/${canvasId}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "RENDER_GRID",
        x: 460,
        y: 220,
        config: {
          rows: 3,
          cols: 3,
          ratio: "16:9",
          resolution: "720p",
          engine: "gemini-visual-pro",
          continuity: true,
          maxParallel: 4,
          prompt: "Futuristic city scene with strong continuity"
        }
      })
    });
    if (!response.ok) {
      appendLog("Add node failed");
      return;
    }
    const node = await response.json();
    setNodes((currentNodes) => [
      ...currentNodes,
      toFlowNode(node)
    ]);
  }, [appendLog, setNodes, toFlowNode]);

  const patchNodeRemote = useCallback(
    async (nodeId: string, patch: Record<string, unknown>) => {
      const response = await fetch(`${apiBase}/v1/nodes/${nodeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: patch })
      });

      if (!response.ok) {
        appendLog(`Node patch failed (${response.status})`);
        return;
      }
      appendLog(`Node patched: ${nodeId}`);
    },
    [appendLog]
  );

  const updateSelectedConfig = useCallback(
    (patch: Record<string, unknown>) => {
      if (!selectedNodeId) return;
      setNodes((currentNodes) =>
        currentNodes.map((node) =>
          node.id === selectedNodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  config: {
                    ...(node.data.config ?? {}),
                    ...patch
                  }
                }
              }
            : node
        )
      );

      patchNodeRemote(selectedNodeId, patch).catch((error) => {
        appendLog(`Node patch error: ${error.message}`);
      });
    },
    [appendLog, patchNodeRemote, selectedNodeId, setNodes]
  );

  const saveCanvas = useCallback(async () => {
    const response = await fetch(`${apiBase}/v1/canvases/${canvasId}/state`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: canvasVersion,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: nodes.map((node) => ({
          id: node.id,
          type: node.data.nodeType,
          x: node.position.x,
          y: node.position.y,
          config: node.data.config,
          status: node.data.status ?? {}
        })),
        edges: edges.map((edge) => ({
          id: edge.id,
          fromNodeId: edge.source,
          toNodeId: edge.target,
          type: edge.label ? String(edge.label) : "DATA",
          config: {}
        }))
      })
    });

    if (!response.ok) {
      appendLog("Save failed (version conflict or validation error)");
      return;
    }
    appendLog("Canvas saved");
    await fetchCanvas();
  }, [appendLog, canvasVersion, edges, fetchCanvas, nodes]);

  const execute = useCallback(async () => {
    const rootNodeId = selectedNodeId ?? nodes.find((node) => node.data.nodeType === "RENDER_GRID")?.id;
    const response = await fetch(`${apiBase}/v1/executions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        canvasId,
        mode,
        rootNodeId
      })
    });
    if (!response.ok) {
      appendLog("Execution failed to start");
      return;
    }
    const payload = await response.json();
    setExecutionId(payload.executionId);
    setExecutionStatus(payload.status);
    appendLog(`Execution started: ${payload.executionId}`);
  }, [appendLog, mode, nodes, selectedNodeId]);

  const executeContinuity = useCallback(async () => {
    const rootNodeId = selectedNodeId ?? nodes.find((node) => node.data.nodeType === "RENDER_GRID")?.id;
    if (!rootNodeId) {
      appendLog("No render node selected for continuity");
      return;
    }

    const response = await fetch(`${apiBase}/v1/executions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        canvasId,
        mode: "CONTINUITY",
        rootNodeId
      })
    });
    if (!response.ok) {
      appendLog("Continuity execution failed to start");
      return;
    }
    const payload = await response.json();
    setExecutionId(payload.executionId);
    setExecutionStatus(payload.status);
    appendLog(`Continuity execution started: ${payload.executionId}`);
  }, [appendLog, nodes, selectedNodeId]);

  const cancelExecution = useCallback(async () => {
    if (!executionId) return;
    await fetch(`${apiBase}/v1/executions/${executionId}/cancel`, { method: "POST" });
  }, [executionId]);

  const createExport = useCallback(async () => {
    if (!executionId) {
      appendLog("No execution to export");
      return;
    }
    setExportStatus("WAITING");
    const response = await fetch(`${apiBase}/v1/exports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        canvasId,
        executionId,
        include: { images: true, prompts: true, metadata: true }
      })
    });
    if (!response.ok) {
      appendLog("Export request failed");
      setExportStatus("FAILED");
      return;
    }
    const payload = await response.json();
    setExportId(payload.exportId);
    setExportStatus(String(payload.status ?? "WAITING"));
    appendLog(`Export requested: ${payload.exportId}`);
  }, [appendLog, executionId]);

  const retryFailedJobs = useCallback(async () => {
    if (!executionId) {
      appendLog("No execution to retry");
      return;
    }

    const response = await fetch(`${apiBase}/v1/executions/${executionId}/retry-failed`, {
      method: "POST"
    });
    if (!response.ok) {
      appendLog("Retry failed jobs request failed");
      return;
    }
    const payload = await response.json();
    appendLog(`Retry failed jobs accepted: ${payload.retried}`);
  }, [appendLog, executionId]);

  const downloadHighRes = useCallback(async () => {
    if (!selectedRender) return;

    if (selectedHighRes?.status === "SUCCEEDED" && selectedHighRes.downloadUrl) {
      window.open(selectedHighRes.downloadUrl, "_blank", "noopener,noreferrer");
      return;
    }

    const response = await fetch(`${apiBase}/v1/renders/${selectedRender.id}/highres`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetResolution: String(selectedConfig.resolution ?? "4k")
      })
    });

    if (!response.ok) {
      appendLog("High-res request failed");
      return;
    }

    const payload = await response.json();
    const status = String(payload.status ?? "WAITING");
    const downloadUrl = payload.downloadUrl ? `${apiBase}${String(payload.downloadUrl)}` : undefined;

    setHighResByRender((prev) => ({
      ...prev,
      [selectedRender.id]: {
        status,
        jobId: payload.jobId ? String(payload.jobId) : prev[selectedRender.id]?.jobId,
        downloadUrl
      }
    }));

    appendLog(`High-res ${selectedRender.id} => ${status}`);
    if (status === "SUCCEEDED" && downloadUrl) {
      window.open(downloadUrl, "_blank", "noopener,noreferrer");
    }
  }, [appendLog, selectedConfig.resolution, selectedHighRes, selectedRender]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr 360px", height: "100vh" }}>
      <aside style={{ borderRight: "1px solid #1f2937", padding: 16, background: "rgba(2,6,23,0.8)" }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Frame-2 MVP</h2>
        <p style={{ color: "#94a3b8", marginTop: 8 }}>{canvasName}</p>

        <label style={{ display: "block", marginTop: 16, fontSize: 12, color: "#94a3b8" }}>Execution Mode</label>
        <select value={mode} onChange={(event) => setMode(event.target.value as any)} style={{ width: "100%", marginTop: 6, padding: 8, background: "#0f172a", color: "#e2e8f0", border: "1px solid #334155" }}>
          <option value="NODE">NODE</option>
          <option value="GRAPH">GRAPH</option>
          <option value="CONTINUITY">CONTINUITY</option>
        </select>

        <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
          <button onClick={addRenderNode}>Add Render Node</button>
          <button onClick={saveCanvas}>Save Canvas</button>
          <button onClick={execute}>Execute</button>
          <button onClick={executeContinuity}>CONTINUE</button>
          <button onClick={retryFailedJobs} disabled={!executionId}>Retry Failed Jobs</button>
          <button onClick={cancelExecution} disabled={!executionId}>Cancel Execution</button>
          <button onClick={createExport} disabled={!executionId || exportStatus === "RUNNING"}>
            {exportStatus === "RUNNING" ? "Exporting..." : "Export ZIP"}
          </button>
        </div>

        <div style={{ marginTop: 18, padding: 10, border: "1px solid #1f2937", background: "#020617" }}>
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8 }}>Selected Render Config</div>
          <label style={{ display: "block", fontSize: 12, color: "#94a3b8" }}>Rows</label>
          <input
            type="number"
            min={1}
            max={6}
            value={Number(selectedConfig.rows ?? 3)}
            onChange={(event) => updateSelectedConfig({ rows: Number(event.target.value) })}
            style={{ width: "100%", marginTop: 4, marginBottom: 8, background: "#0f172a", color: "#e2e8f0", border: "1px solid #334155", padding: 6 }}
            disabled={!selectedNodeId}
          />

          <label style={{ display: "block", fontSize: 12, color: "#94a3b8" }}>Cols</label>
          <input
            type="number"
            min={1}
            max={6}
            value={Number(selectedConfig.cols ?? 3)}
            onChange={(event) => updateSelectedConfig({ cols: Number(event.target.value) })}
            style={{ width: "100%", marginTop: 4, marginBottom: 8, background: "#0f172a", color: "#e2e8f0", border: "1px solid #334155", padding: 6 }}
            disabled={!selectedNodeId}
          />

          <label style={{ display: "block", fontSize: 12, color: "#94a3b8" }}>Ratio</label>
          <select
            value={String(selectedConfig.ratio ?? "16:9")}
            onChange={(event) => updateSelectedConfig({ ratio: event.target.value })}
            style={{ width: "100%", marginTop: 4, marginBottom: 8, background: "#0f172a", color: "#e2e8f0", border: "1px solid #334155", padding: 6 }}
            disabled={!selectedNodeId}
          >
            <option value="1:1">1:1</option>
            <option value="4:3">4:3</option>
            <option value="3:4">3:4</option>
            <option value="16:9">16:9</option>
            <option value="9:16">9:16</option>
            <option value="21:9">21:9</option>
          </select>

          <label style={{ display: "block", fontSize: 12, color: "#94a3b8" }}>Prompt</label>
          <textarea
            value={String(selectedConfig.prompt ?? "")}
            onChange={(event) => updateSelectedConfig({ prompt: event.target.value })}
            style={{ width: "100%", marginTop: 4, marginBottom: 8, minHeight: 90, background: "#0f172a", color: "#e2e8f0", border: "1px solid #334155", padding: 6 }}
            disabled={!selectedNodeId}
          />

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#94a3b8" }}>
            <input
              type="checkbox"
              checked={Boolean(selectedConfig.continuity ?? true)}
              onChange={(event) => updateSelectedConfig({ continuity: event.target.checked })}
              disabled={!selectedNodeId}
            />
            Continuity ON
          </label>
        </div>

        <div style={{ marginTop: 16, fontSize: 13, color: "#cbd5e1" }}>
          <div>Execution: {executionStatus}</div>
          <div>ID: {executionId ?? "-"}</div>
          <div>Export: {exportId ?? "-"}</div>
          <div>Export Status: {exportStatus}</div>
          {exportDownloadUrl ? (
            <a href={exportDownloadUrl} target="_blank" rel="noreferrer" style={{ color: "#93c5fd" }}>
              Download ZIP
            </a>
          ) : null}
        </div>

        <pre style={{ marginTop: 16, height: 260, overflow: "auto", fontSize: 11, background: "#020617", border: "1px solid #1f2937", padding: 8, color: "#93c5fd" }}>
          {logLines.join("\n")}
        </pre>
      </aside>

      <main style={{ position: "relative" }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
          fitView
        >
          <Background color="#1e293b" gap={24} />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </main>

      <aside style={{ borderLeft: "1px solid #1f2937", padding: 16, background: "rgba(2,6,23,0.82)", overflow: "auto" }}>
        <h3 style={{ marginTop: 0 }}>Inspector</h3>
        <div style={{ color: "#94a3b8", fontSize: 13 }}>Node: {selectedNodeId ?? "none"}</div>
        <div style={{ color: "#94a3b8", fontSize: 13, marginTop: 4 }}>Type: {selectedNode?.data.nodeType ?? "-"}</div>
        <div style={{ color: "#94a3b8", fontSize: 13, marginTop: 4 }}>Aspect: {String(selectedConfig.ratio ?? "-")}</div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 14 }}>
          <button
            onClick={() => setInspectorTab("PROPERTIES")}
            style={{
              background: inspectorTab === "PROPERTIES" ? "#a3e635" : "#0f172a",
              color: inspectorTab === "PROPERTIES" ? "#111827" : "#cbd5e1",
              border: "1px solid #334155",
              padding: "8px 10px"
            }}
          >
            PROPERTIES
          </button>
          <button
            onClick={() => setInspectorTab("AI_ANALYSIS")}
            style={{
              background: inspectorTab === "AI_ANALYSIS" ? "#a3e635" : "#0f172a",
              color: inspectorTab === "AI_ANALYSIS" ? "#111827" : "#cbd5e1",
              border: "1px solid #334155",
              padding: "8px 10px"
            }}
          >
            AI ANALYSIS
          </button>
        </div>

        <h4 style={{ marginTop: 18 }}>Renders</h4>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
          <select
            value={renderSort}
            onChange={(event) => setRenderSort(event.target.value as "createdAt:desc" | "createdAt:asc")}
            style={{ background: "#0f172a", color: "#e2e8f0", border: "1px solid #334155", padding: 6 }}
          >
            <option value="createdAt:desc">Newest</option>
            <option value="createdAt:asc">Oldest</option>
          </select>
          <select
            value={String(renderLimit)}
            onChange={(event) => setRenderLimit(Number(event.target.value))}
            style={{ background: "#0f172a", color: "#e2e8f0", border: "1px solid #334155", padding: 6 }}
          >
            <option value="9">9 items</option>
            <option value="24">24 items</option>
            <option value="60">60 items</option>
          </select>
        </div>
        <input
          placeholder="Filter executionId (optional)"
          value={renderExecutionFilter}
          onChange={(event) => setRenderExecutionFilter(event.target.value)}
          style={{
            width: "100%",
            marginBottom: 10,
            background: "#0f172a",
            color: "#e2e8f0",
            border: "1px solid #334155",
            padding: 6
          }}
        />
        <div style={{ display: "grid", gap: 12 }}>
          {renders.map((render) => (
            <div
              key={render.id}
              style={{
                border: render.id === selectedRender?.id ? "1px solid #a3e635" : "1px solid #1f2937",
                background: "#020617",
                borderRadius: 8,
                overflow: "hidden",
                cursor: "pointer"
              }}
              onClick={() => setSelectedRenderId(render.id)}
            >
              <img src={`${apiBase}${render.asset.url}`} alt={`render-${render.gridIndex}`} style={{ width: "100%", display: "block" }} />
              <div style={{ padding: 10, fontSize: 12, color: "#cbd5e1" }}>
                <div>Cell #{render.gridIndex + 1}</div>
                <div style={{ color: "#64748b" }}>{new Date(render.createdAt).toLocaleString()}</div>
                <details style={{ marginTop: 8 }}>
                  <summary>Prompt Snapshot</summary>
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, color: "#93c5fd" }}>{JSON.stringify(render.promptSnapshot, null, 2)}</pre>
                </details>
              </div>
            </div>
          ))}
        </div>

        {inspectorTab === "PROPERTIES" ? (
          <div style={{ marginTop: 16, border: "1px solid #1f2937", background: "#020617", padding: 12 }}>
            <div style={{ fontSize: 12, color: "#64748b" }}>TYPE</div>
            <div style={{ fontSize: 13, color: "#cbd5e1", marginTop: 4 }}>{selectedNode?.data.nodeType ?? "-"}</div>

            <div style={{ fontSize: 12, color: "#64748b", marginTop: 10 }}>ASPECT</div>
            <div style={{ fontSize: 13, color: "#cbd5e1", marginTop: 4 }}>{String(selectedConfig.ratio ?? "-")}</div>

            <div style={{ fontSize: 12, color: "#64748b", marginTop: 10 }}>ENTITY ID</div>
            <div style={{ fontSize: 13, color: "#cbd5e1", marginTop: 4 }}>{selectedNodeId ?? "-"}</div>

            <div style={{ fontSize: 12, color: "#64748b", marginTop: 10 }}>DIRECTOR PROMPT</div>
            <div style={{ fontSize: 13, color: "#cbd5e1", marginTop: 4, whiteSpace: "pre-wrap" }}>
              {String(selectedConfig.prompt ?? "-")}
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 16, border: "1px solid #1f2937", background: "#020617", padding: 12 }}>
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ fontSize: 12, color: "#64748b" }}>Continuity Score</div>
              <div style={{ fontSize: 20, color: "#a3e635" }}>{analysis.continuity}</div>
              <div style={{ fontSize: 12, color: "#64748b" }}>Coverage Score</div>
              <div style={{ fontSize: 20, color: "#a3e635" }}>{analysis.coverage}</div>
              <div style={{ fontSize: 12, color: "#64748b" }}>Prompt Strength</div>
              <div style={{ fontSize: 20, color: "#a3e635" }}>{analysis.promptStrength}</div>
            </div>
            <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
              {analysis.notes.map((note) => (
                <div key={note} style={{ fontSize: 12, color: "#cbd5e1" }}>
                  - {note}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12, display: "grid", gap: 4 }}>
              {analysis.evidence.map((item) => (
                <div key={item.key} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#93c5fd" }}>
                  <span>{item.key}</span>
                  <span>{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <button
          onClick={downloadHighRes}
          disabled={!selectedRender}
          style={{
            marginTop: 14,
            width: "100%",
            padding: "12px 10px",
            background: selectedRender ? "#1f2937" : "#111827",
            color: selectedRender ? "#e5e7eb" : "#6b7280",
            border: "1px solid #334155"
          }}
        >
          {selectedHighRes?.status === "RUNNING" || selectedHighRes?.status === "RETRYING" || selectedHighRes?.status === "WAITING" || selectedHighRes?.status === "QUEUED"
            ? "HIGH-RES GENERATING..."
            : selectedHighRes?.status === "SUCCEEDED"
              ? "DOWNLOAD HIGH-RES"
              : "GENERATE HIGH-RES"}
        </button>
      </aside>
    </div>
  );
}

export default function Page() {
  return (
    <ReactFlowProvider>
      <Workbench />
    </ReactFlowProvider>
  );
}
