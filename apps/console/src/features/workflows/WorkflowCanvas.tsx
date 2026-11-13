import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  GitBranch,
  Play,
  ShieldCheck,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { useRegistry } from '@seamnex/api-client';
import type { Workflow, WorkflowNode } from '@seamnex/domain';
import { can, OPERATION_MODE_LABELS, TRIGGER_LABELS } from '@seamnex/domain';
import {
  Badge,
  Button,
  Callout,
  DefinitionList,
  InlineNote,
  Panel,
  PanelHeader,
  SkeletonLines,
  Tag,
} from '@seamnex/ui';
import { cn } from '@seamnex/utils';
import { useSession } from '../../session';
import { MappingWorkbench } from './field-mapping/mapping-workbench';

const NODE_WIDTH = 184;
const NODE_HEIGHT = 82;

function kindLabel(node: WorkflowNode): string {
  if (node.kind === 'trigger') return 'Trigger';
  if (node.kind === 'condition') return 'Condition';
  if (node.kind === 'approval') return 'Approval';
  if (node.kind === 'mapping') return 'Mapping';
  return 'Action';
}

function NodeCard({
  node,
  selected,
  issues,
  onSelect,
}: {
  node: WorkflowNode;
  selected: boolean;
  issues: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{ left: node.x, top: node.y, width: NODE_WIDTH, minHeight: NODE_HEIGHT }}
      className={cn(
        'absolute z-node flex flex-col rounded-sm border bg-panel p-2.5 text-left shadow-panel transition-[border-color,box-shadow]',
        selected
          ? 'border-primary shadow-focus-halo'
          : 'border-line-strong hover:border-primary-hover',
      )}
      aria-pressed={selected}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-faint label-caps">{kindLabel(node)}</span>
        <div className="flex items-center gap-1">
          {issues > 0 ? (
            <span className="inline-flex items-center gap-0.5 text-micro font-semibold text-danger">
              <AlertTriangle className="size-3" aria-hidden /> {issues}
            </span>
          ) : null}
          <Badge tone={node.mode === 'write' ? 'caution' : 'neutral'} size="sm">
            {node.mode}
          </Badge>
        </div>
      </div>
      <p className="mt-1 line-clamp-2 text-meta leading-snug font-semibold text-text">
        {node.label}
      </p>
      <p className="mt-auto pt-1 font-mono text-micro text-faint">
        {node.entryKey ?? 'platform'} · {node.operation ?? 'no operation'}
      </p>
    </button>
  );
}

export function WorkflowCanvas({
  workflow,
  selectedId,
  onSelect,
}: {
  workflow: Workflow;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const registry = useRegistry();
  const { session } = useSession();
  const selected = workflow.nodes.find((node) => node.id === selectedId) ?? null;
  /**
   * The workbench is opened from the selected node, not toggled from the canvas: one node at a time,
   * and closing it returns the author to the same selection.
   */
  const [mappingNodeId, setMappingNodeId] = useState<string | null>(null);
  const mappingNode = workflow.nodes.find((node) => node.id === mappingNodeId) ?? null;

  const issueCount = useMemo(() => {
    const map = new Map<string, number>();
    workflow.validation.issues.forEach((issue) => {
      if (issue.nodeId) map.set(issue.nodeId, (map.get(issue.nodeId) ?? 0) + 1);
    });
    return map;
  }, [workflow.validation.issues]);

  /**
   * Edge lookup by id. Two `find` calls per edge made drawing the canvas O(edges × nodes) — and
   * the canvas re-renders on every node selection. The bounds are computed in the same pass.
   */
  const nodesById = useMemo(
    () => new Map(workflow.nodes.map((node) => [node.id, node])),
    [workflow.nodes],
  );
  const bounds = useMemo(() => {
    let maxX = 0;
    let maxY = 0;
    for (const node of workflow.nodes) {
      if (node.x > maxX) maxX = node.x;
      if (node.y > maxY) maxY = node.y;
    }
    return { width: maxX + NODE_WIDTH + 40, height: maxY + NODE_HEIGHT + 40 };
  }, [workflow.nodes]);
  const { width, height } = bounds;

  return (
    <div className="grid gap-3 xl:grid-cols-[210px_1fr_280px]">
      <Panel className="order-2 xl:order-1">
        <PanelHeader eyebrow="Discovery" title="Node palette" className="px-3" />
        <div className="scroll-slim flex max-h-[420px] flex-col gap-2 overflow-y-auto overscroll-contain p-3">
          {registry.isPending ? <SkeletonLines lines={5} /> : null}
          {(registry.data ?? []).slice(0, 8).map((entry) => (
            <div key={entry.instanceId}>
              <p className="flex items-center gap-1 font-mono text-faint label-caps">
                {entry.entryKey} · {entry.product}
              </p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {entry.operations.slice(0, 3).map((operation) => {
                  const descriptionId = `operation-${entry.instanceId}-${operation.id}-description`;
                  return (
                    <li key={operation.id}>
                      {/*
                        Rule: a tooltip trigger must be focusable, or the same text must exist as
                        text. This row is not actionable, so a focusable trigger would add one tab
                        stop per operation — 24 of them on a full palette — to reach a sentence.
                        Instead the sentence is the native `title` for pointer users and real text
                        for everyone else: visually hidden, in reading order, and also referenced by
                        `aria-describedby` so assistive technology that resolves descriptions for
                        the row finds it without leaving the row.
                      */}
                      <span
                        title={operation.description}
                        aria-describedby={descriptionId}
                        className="flex w-full cursor-default items-center justify-between gap-1 rounded-xs px-1.5 py-1 text-micro text-muted hover:bg-paper-deep"
                      >
                        <span className="truncate">{operation.label}</span>
                        <span
                          className={cn(
                            'font-mono text-micro',
                            operation.mode === 'write' ? 'text-warning-strong' : 'text-faint',
                          )}
                        >
                          {OPERATION_MODE_LABELS[operation.mode][0]}
                        </span>
                      </span>
                      <span id={descriptionId} className="sr-only">
                        {operation.description}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          <InlineNote>
            Palette entries come from the registry. Dragging is disabled in this prototype; nodes
            below are the workflow's current definition.
          </InlineNote>
        </div>
      </Panel>

      <Panel className="order-1 min-w-0 overflow-hidden xl:order-2">
        <PanelHeader
          eyebrow={`${workflow.nodes.length} nodes · ${workflow.edges.length} connections`}
          title="Workflow canvas"
          description={`Trigger: ${TRIGGER_LABELS[workflow.trigger.type] ?? workflow.trigger.type} — ${workflow.trigger.label}`}
        />
        <div className="scroll-slim overflow-x-auto overscroll-x-contain">
          <div className="grid-lines [--grid-cell:8px] relative" style={{ width, height }}>
            <svg className="absolute inset-0 size-full" width={width} height={height} aria-hidden>
              <defs>
                <marker
                  id="wf-arrow"
                  markerWidth="6"
                  markerHeight="6"
                  refX="5"
                  refY="3"
                  orient="auto"
                >
                  <path d="M0,0 L6,3 L0,6 Z" fill="var(--color-line-strong)" />
                </marker>
              </defs>
              {workflow.edges.map((edge) => {
                const source = nodesById.get(edge.source);
                const target = nodesById.get(edge.target);
                if (!source || !target) return null;
                const x1 = source.x + NODE_WIDTH;
                const y1 = source.y + NODE_HEIGHT / 2;
                const x2 = target.x;
                const y2 = target.y + NODE_HEIGHT / 2;
                const mid = (x1 + x2) / 2;
                return (
                  <path
                    key={edge.id}
                    d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke="var(--color-line-strong)"
                    strokeWidth={1.25}
                    markerEnd="url(#wf-arrow)"
                  />
                );
              })}
            </svg>

            {workflow.nodes.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                selected={node.id === selectedId}
                issues={issueCount.get(node.id) ?? 0}
                onSelect={() => onSelect(node.id)}
              />
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-3 py-2 text-micro text-faint">
          <span className="inline-flex items-center gap-1">
            <WorkflowIcon className="size-3" aria-hidden /> node
          </span>
          <span className="inline-flex items-center gap-1">
            <GitBranch className="size-3" aria-hidden /> connection
          </span>
          <span className="inline-flex items-center gap-1">
            <AlertTriangle className="size-3 text-danger" aria-hidden /> validation issue
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            <ShieldCheck className="size-3" aria-hidden /> credentials brokered
          </span>
        </div>
      </Panel>

      <Panel className="order-3">
        <PanelHeader
          eyebrow="Inspector"
          title={selected ? selected.label : 'Workflow settings'}
          className="px-3"
        />
        <div className="scroll-slim max-h-[420px] overflow-y-auto overscroll-contain p-3">
          {selected ? (
            <div className="flex flex-col gap-3">
              <DefinitionList
                columns={1}
                items={[
                  { label: 'Kind', value: kindLabel(selected) },
                  {
                    label: 'Product',
                    value: `${selected.entryKey ?? 'Platform'} · ${selected.product}`,
                  },
                  { label: 'Operation', value: selected.operation ?? '—', mono: true },
                  { label: 'Access', value: OPERATION_MODE_LABELS[selected.mode] },
                ]}
              />
              <p className="text-meta leading-relaxed text-muted">{selected.summary}</p>
              {selected.kind === 'trigger' ? (
                <InlineNote>
                  The trigger carries the incoming payload; map fields on the nodes it feeds.
                </InlineNote>
              ) : (
                <MappingSummary
                  node={selected}
                  canAuthor={can(session.role, 'workflow.author')}
                  onMap={() => setMappingNodeId(selected.id)}
                />
              )}
              <NodeIssues workflow={workflow} nodeId={selected.id} />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <DefinitionList
                columns={1}
                items={[
                  { label: 'Owner', value: workflow.owner.name },
                  { label: 'Version', value: String(workflow.version) },
                  { label: 'IR hash', value: workflow.irHash, mono: true },
                  {
                    label: 'Write targets',
                    value: workflow.writeTargets
                      .map((target) => `${target.entryKey} ${target.product}`)
                      .join(', '),
                  },
                  {
                    label: 'Credential scopes',
                    value: `${workflow.credentialScopes.filter((scope) => scope.revokedAt === null).length} active`,
                  },
                ]}
              />
              <div>
                <p className="mb-1 font-mono text-faint label-caps">Scopes</p>
                <ul className="flex flex-col gap-1">
                  {workflow.credentialScopes.map((scope) => (
                    <li
                      key={scope.id}
                      className="rounded-xs border border-line bg-panel-soft p-1.5"
                    >
                      <p className="text-micro text-text">{scope.product}</p>
                      <p className="font-mono text-micro text-faint">
                        {scope.operations.join(', ')} · {scope.mode} · expires{' '}
                        {scope.expiresAt.slice(0, 10)}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
              <Callout tone="info" title="Brokered credentials">
                Authors select operations, never passwords. The broker injects a scoped credential
                on egress.
              </Callout>
            </div>
          )}
        </div>
        <div className="border-t border-line px-3 py-2">
          <span className="inline-flex items-center gap-1 font-mono text-micro text-faint">
            <Play className="size-3" aria-hidden /> layout read-only · mappings editable
          </span>
        </div>
      </Panel>

      {mappingNode === null ? null : (
        <MappingWorkbench
          workflow={workflow}
          node={mappingNode}
          open
          onOpenChange={(next) => {
            if (!next) setMappingNodeId(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * What the inspector shows instead of the editor it used to hold.
 *
 * A 280 px column cannot display a ledger, and the two inputs that fit there were the reason the
 * feature read as hard. The count and the first rows are enough to know whether the node is mapped;
 * the workbench is where the editing happens.
 */
function MappingSummary({
  node,
  canAuthor,
  onMap,
}: {
  node: WorkflowNode;
  canAuthor: boolean;
  onMap: () => void;
}) {
  const visible = node.mappings.slice(0, 3);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-faint label-caps">Field mapping</p>
        <span className="text-micro text-faint">{node.mappings.length} mapped</span>
      </div>
      {node.mappings.length === 0 ? (
        <p className="text-meta leading-snug text-faint">
          No field mapping yet. A write node with no mapping sends no body, so the product refuses
          the run.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {visible.map((mapping, index) => (
            <li
              key={`${mapping.from}-${mapping.to}-${index}`}
              className="truncate rounded-xs border border-line bg-panel-soft px-1.5 py-1 font-mono text-micro text-text"
            >
              {mapping.from} → {mapping.to}
            </li>
          ))}
        </ul>
      )}
      {node.mappings.length > visible.length ? (
        <p className="text-micro text-faint">+{node.mappings.length - visible.length} more</p>
      ) : null}
      {canAuthor ? (
        <Button size="sm" variant="primary" onClick={onMap}>
          Map fields
        </Button>
      ) : (
        <>
          {/*
           * A reviewer is accountable for the definition, so the mapping is readable to them: the
           * ledger, its structural problems and the compiled body, without any editor.
           */}
          <Button size="sm" variant="ghost" onClick={onMap}>
            View mapping
          </Button>
          <InlineNote>Read-only: editing needs the workflow author.</InlineNote>
        </>
      )}
    </div>
  );
}

function NodeIssues({ workflow, nodeId }: { workflow: Workflow; nodeId: string }) {
  const issues = workflow.validation.issues.filter((issue) => issue.nodeId === nodeId);
  if (issues.length === 0)
    return (
      <Badge tone="positive" size="sm">
        no issues on this node
      </Badge>
    );
  return (
    <ul className="flex flex-col gap-1.5">
      {issues.map((issue) => (
        <li key={issue.id} className="rounded-xs border border-danger-border bg-danger-wash p-2">
          <div className="flex items-center gap-1">
            <Badge tone={issue.severity === 'error' ? 'danger' : 'caution'} size="sm">
              {issue.severity}
            </Badge>
            <Tag mono>{issue.code}</Tag>
          </div>
          <p className="mt-1 text-micro leading-snug text-text">{issue.message}</p>
          <p className="mt-0.5 text-micro text-link">{issue.remediation}</p>
        </li>
      ))}
    </ul>
  );
}
