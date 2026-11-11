import { useId } from "react";
import {
  type PermissionMode,
  type PermissionModes,
  permissions,
  type Scope,
} from "../shared/permissions.ts";
import { Select } from "./ui.tsx";

export function Category({
  label,
  scopes,
  modes,
  change,
}: {
  label: string;
  scopes: Scope[];
  modes: PermissionModes;
  change: (scopes: Scope[], mode: PermissionMode | "deny") => void;
}) {
  const prefix = useId();
  const count = scopes.filter((scope) => modes[scope]).length;
  const approvalCount = scopes.filter((scope) => modes[scope] === "approval").length;
  const supportsApproval = scopes.some((scope) => permissions[scope].approval);
  const reviewMode =
    supportsApproval &&
    scopes.every(
      (scope) =>
        modes[scope] ===
        (permissions[scope].approval
          ? "approval"
          : permissions[scope].defaultAllowed
            ? "allow"
            : undefined),
    );
  const mode =
    count === 0
      ? "deny"
      : reviewMode
        ? "approval"
        : count === scopes.length && approvalCount === 0
          ? "allow"
          : "mixed";
  return (
    <details className="permission-category">
      <summary>
        <span>{label}</span>
        <small>
          {count} selected{approvalCount ? ` · ${approvalCount} need approval` : ""}
        </small>
        <Select
          aria-label={`${label} access`}
          value={mode}
          onChange={(event) => change(scopes, event.target.value as PermissionMode | "deny")}
        >
          <option value="mixed" disabled>
            Mixed
          </option>
          <option value="deny">Deny all</option>
          {supportsApproval && <option value="approval">Read; approve execution</option>}
          <option value="allow">Allow all</option>
        </Select>
      </summary>
      {scopes.map((scope) => (
        <label key={scope} htmlFor={`${prefix}-${scope}`} className="permission-choice">
          {permissions[scope].approval ? (
            <>
              <span>{permissions[scope].label}</span>
              <Select
                id={`${prefix}-${scope}`}
                aria-label={permissions[scope].label}
                value={modes[scope] ?? "deny"}
                onChange={(event) => change([scope], event.target.value as PermissionMode | "deny")}
              >
                <option value="deny">Deny</option>
                <option value="approval">Require approval</option>
                <option value="allow">Allow without approval</option>
              </Select>
            </>
          ) : (
            <>
              <input
                id={`${prefix}-${scope}`}
                type="checkbox"
                checked={!!modes[scope]}
                onChange={(event) => change([scope], event.target.checked ? "allow" : "deny")}
              />
              <span>{permissions[scope].label}</span>
            </>
          )}
        </label>
      ))}
    </details>
  );
}
export function ResourceCategory({
  title,
  items,
  selected,
  change,
}: {
  title: string;
  items: { id: string; name: string }[];
  selected: "*" | string[];
  change: (value: "*" | string[]) => void;
}) {
  return (
    <details className="permission-category">
      <summary>
        <span>{title}</span>
        <small>{selected === "*" ? "All, including new" : `${selected.length} selected`}</small>
      </summary>
      <label className="permission-choice">
        <input
          type="checkbox"
          checked={selected === "*"}
          onChange={(event) => change(event.target.checked ? "*" : [])}
        />
        <span>All {title.toLowerCase()}, including new ones</span>
      </label>
      {items.map((item) => (
        <label key={item.id} className="permission-choice">
          <input
            type="checkbox"
            checked={selected === "*" || selected.includes(item.id)}
            onChange={(event) => {
              const ids = new Set(selected === "*" ? items.map((item) => item.id) : selected);
              if (event.target.checked) ids.add(item.id);
              else ids.delete(item.id);
              change([...ids]);
            }}
          />
          <span>{item.name}</span>
        </label>
      ))}
    </details>
  );
}
