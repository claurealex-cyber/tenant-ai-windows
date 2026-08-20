"use client";

import { useCallback, useEffect, useState } from "react";
import DashboardShell from "@/components/layout/DashboardShell";

interface RelayField {
  key: string;
  label: string;
  sensitive: boolean;
  required: boolean;
  placeholder: string | null;
  helpText: string | null;
  hasValue: boolean;
  source: "database" | "environment" | "none";
}

interface RelayProperty {
  id: string;
  name: string;
  twilioPhone: string | null;
  isActive: boolean;
  smsIntakeEnabled: boolean;
  intakeAutoReply: string | null;
}

interface RelayStatus {
  intakeProperties: number;
  outstandingInvites: number;
  optOutCount: number;
  ledger: { pending: number; failed: number; sent: number } | null;
  relayTransport?: {
    name: "macos-messages" | "none";
    available: boolean;
    reason: string | null;
    platform: string;
  };
}

export default function SmsRelayPage() {
  const [fields, setFields] = useState<RelayField[]>([]);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [properties, setProperties] = useState<RelayProperty[]>([]);
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [optOutPhone, setOptOutPhone] = useState("");
  const [autoReplyDrafts, setAutoReplyDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [intRes, propRes, statRes] = await Promise.all([
        fetch("/api/admin/integrations"),
        fetch("/api/admin/sms-relay/property"),
        fetch("/api/admin/sms-relay/status"),
      ]);
      if (intRes.ok) {
        const data = await intRes.json();
        const relay = (data.integrations || []).find((i: any) => i.id === "sms_relay");
        setFields(relay?.fields || []);
      }
      if (propRes.ok) {
        const data = await propRes.json();
        setProperties(data.properties || []);
        setAutoReplyDrafts(
          Object.fromEntries(
            (data.properties || []).map((p: RelayProperty) => [p.id, p.intakeAutoReply || ""])
          )
        );
      }
      if (statRes.ok) setStatus(await statRes.json());
    } catch {
      setBanner({ kind: "err", text: "Failed to load SMS relay settings" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveSettings = async () => {
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(fieldValues)) {
      if (v !== "") values[k] = v;
    }
    if (Object.keys(values).length === 0) {
      setBanner({ kind: "err", text: "No changes to save" });
      return;
    }
    setSaving(true);
    setBanner(null);
    try {
      const res = await fetch("/api/admin/integrations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integrationId: "sms_relay", values }),
      });
      if (res.ok) {
        setBanner({ kind: "ok", text: "Settings saved. The server picks up changes within 60 seconds." });
        setFieldValues({});
        await load();
      } else {
        const data = await res.json().catch(() => ({}));
        setBanner({ kind: "err", text: data.error || "Save failed" });
      }
    } catch {
      setBanner({ kind: "err", text: "Save failed" });
    } finally {
      setSaving(false);
    }
  };

  const patchProperty = async (
    propertyId: string,
    patch: { smsIntakeEnabled?: boolean; intakeAutoReply?: string }
  ) => {
    setBanner(null);
    const res = await fetch("/api/admin/sms-relay/property", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ propertyId, ...patch }),
    });
    if (res.ok) {
      setBanner({ kind: "ok", text: "Property updated" });
      await load();
    } else {
      const data = await res.json().catch(() => ({}));
      setBanner({ kind: "err", text: data.error || "Update failed" });
    }
  };

  const submitOptOut = async () => {
    const property = properties.find((p) => p.smsIntakeEnabled) || properties[0];
    if (!property) {
      setBanner({ kind: "err", text: "No phone-bearing property found" });
      return;
    }
    const res = await fetch("/api/admin/sms-relay/optout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: optOutPhone.trim(), propertyId: property.id }),
    });
    if (res.ok) {
      setBanner({ kind: "ok", text: `${optOutPhone.trim()} opted out` });
      setOptOutPhone("");
      await load();
    } else {
      const data = await res.json().catch(() => ({}));
      setBanner({ kind: "err", text: data.error || "Opt-out failed" });
    }
  };

  return (
    <DashboardShell>
      <div className="mx-auto max-w-4xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">SMS Relay</h1>
          <p className="mt-1 text-sm text-gray-500">
            Temporary workflow while 10DLC registration is pending: inbound texts arrive via
            Telnyx; outbound (survey links and forwards) go out through the Mac&apos;s Messages
            app from the personal number.
          </p>
        </div>

        {banner && (
          <div
            className={`mb-4 rounded-md px-4 py-3 text-sm ${
              banner.kind === "ok"
                ? "bg-green-50 text-green-800"
                : "bg-red-50 text-red-800"
            }`}
          >
            {banner.text}
          </div>
        )}

        {!loading && status?.relayTransport && !status.relayTransport.available && (
          <div
            className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            role="status"
            data-testid="relay-unavailable-banner"
          >
            <span className="font-semibold">Relay not available on this machine.</span>{" "}
            {status.relayTransport.reason}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
          </div>
        ) : (
          <div className="space-y-6">
            {/* Status panel */}
            <div className="rounded-lg border border-gray-200 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">Status</h2>
              <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-gray-500">Intake-enabled properties</dt>
                  <dd className="mt-1 text-lg font-semibold text-gray-900">
                    {status?.intakeProperties ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Outstanding survey invites</dt>
                  <dd className="mt-1 text-lg font-semibold text-gray-900">
                    {status?.outstandingInvites ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Opt-outs recorded</dt>
                  <dd className="mt-1 text-lg font-semibold text-gray-900">
                    {status?.optOutCount ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Relay sends</dt>
                  <dd className="mt-1 text-lg font-semibold text-gray-900">
                    {status?.ledger
                      ? `${status.ledger.sent} sent / ${status.ledger.failed} failed`
                      : "engine not deployed"}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Property intake toggles */}
            <div className="rounded-lg border border-gray-200 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">SMS Intake per Property</h2>
              <p className="mt-1 text-xs text-gray-500">
                ON = inbound texts get the survey link. OFF = normal AI apply conversation.
                This is also the retirement switch once 10DLC approves.
              </p>
              <div className="mt-4 space-y-4">
                {properties.map((p) => (
                  <div key={p.id} className="rounded-md border border-gray-100 p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-gray-900">{p.name}</span>
                        <span className="ml-2 text-xs text-gray-500">{p.twilioPhone}</span>
                        {!p.isActive && (
                          <span className="ml-2 rounded bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-800">
                            inactive
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() =>
                          patchProperty(p.id, { smsIntakeEnabled: !p.smsIntakeEnabled })
                        }
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          p.smsIntakeEnabled ? "bg-blue-600" : "bg-gray-200"
                        }`}
                        aria-label={`Toggle SMS intake for ${p.name}`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            p.smsIntakeEnabled ? "translate-x-6" : "translate-x-1"
                          }`}
                        />
                      </button>
                    </div>
                    <div className="mt-3">
                      <label className="block text-xs font-medium text-gray-700">
                        Intake auto-reply (sent with the survey link)
                      </label>
                      <textarea
                        value={autoReplyDrafts[p.id] ?? ""}
                        onChange={(e) =>
                          setAutoReplyDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                        }
                        rows={2}
                        placeholder="Thanks for your interest! Fill out our quick application: "
                        className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      {(autoReplyDrafts[p.id] ?? "") !== (p.intakeAutoReply || "") && (
                        <button
                          onClick={() =>
                            patchProperty(p.id, { intakeAutoReply: autoReplyDrafts[p.id] ?? "" })
                          }
                          className="mt-2 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                        >
                          Save auto-reply
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {properties.length === 0 && (
                  <p className="text-sm text-gray-500">No phone-bearing properties found.</p>
                )}
              </div>
            </div>

            {/* Relay settings */}
            <div className="rounded-lg border border-gray-200 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">Relay Settings</h2>
              <div className="mt-4 space-y-4">
                {fields.map((field) => (
                  <div key={field.key}>
                    <div className="flex items-center justify-between">
                      <label className="block text-sm font-medium text-gray-700">
                        {field.label}
                        {field.required && <span className="ml-1 text-red-500">*</span>}
                      </label>
                      {field.hasValue && (
                        <span
                          className={`text-xs ${
                            field.source === "database" ? "text-blue-500" : "text-gray-400"
                          }`}
                        >
                          from {field.source}
                        </span>
                      )}
                    </div>
                    <input
                      type={field.sensitive ? "password" : "text"}
                      value={fieldValues[field.key] ?? ""}
                      onChange={(e) =>
                        setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                      }
                      placeholder={
                        field.hasValue ? "********** (unchanged)" : field.placeholder || ""
                      }
                      className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    {field.helpText && (
                      <p className="mt-1 text-xs text-gray-500">{field.helpText}</p>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-6">
                <button
                  onClick={saveSettings}
                  disabled={saving}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save Settings"}
                </button>
              </div>
            </div>

            {/* Manual opt-out */}
            <div className="rounded-lg border border-gray-200 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">Manual Opt-Out</h2>
              <p className="mt-1 text-xs text-gray-500">
                If someone replies STOP to your personal Messages thread, record it here so the
                relay never texts them again.
              </p>
              <div className="mt-3 flex gap-2">
                <input
                  type="text"
                  value={optOutPhone}
                  onChange={(e) => setOptOutPhone(e.target.value)}
                  placeholder="+17085551234"
                  className="block w-64 rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  onClick={submitOptOut}
                  disabled={!optOutPhone.trim()}
                  className="rounded-md bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-50"
                >
                  Opt Out
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardShell>
  );
}
