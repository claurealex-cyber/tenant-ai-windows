"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import DashboardShell from "@/components/layout/DashboardShell";
import Pagination, { usePagination } from "@/components/Pagination";

interface Application {
  id: string;
  fullName: string | null;
  callerPhone: string | null;
  email: string | null;
  channel: string;
  status: string;
  createdAt: string;
  property: {
    id: string;
    name: string;
  };
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const STATUS_FILTERS = [
  { label: "All", value: "" },
  { label: "In Progress", value: "in_progress" },
  { label: "Completed", value: "completed" },
  { label: "Reviewed", value: "reviewed" },
  { label: "Rejected", value: "rejected" },
];

const CHANNEL_FILTERS = [
  { label: "All channels", value: "" },
  { label: "Web", value: "web" },
  { label: "SMS Link", value: "sms_link" },
  { label: "Applied online", value: "web_link" },
  { label: "SMS", value: "sms" },
  { label: "Voice", value: "voice" },
];

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: "bg-green-100 text-green-700",
    reviewed: "bg-green-100 text-green-700",
    in_progress: "bg-yellow-100 text-yellow-700",
    rejected: "bg-red-100 text-red-700",
  };

  const labels: Record<string, string> = {
    completed: "Completed",
    reviewed: "Reviewed",
    in_progress: "In Progress",
    rejected: "Rejected",
  };

  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${
        styles[status] || "bg-gray-100 text-gray-700"
      }`}
    >
      {labels[status] || status}
    </span>
  );
}

function ChannelLabel({ channel }: { channel: string }) {
  if (channel === "voice") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700" title="Voice">
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
        </svg>
        Voice
      </span>
    );
  }
  if (channel === "sms") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 px-2.5 py-0.5 text-xs font-medium text-purple-700" title="SMS">
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
        </svg>
        SMS
      </span>
    );
  }
  if (channel === "web_link") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-teal-100 px-2.5 py-0.5 text-xs font-medium text-teal-700" title="Applied on the public site">
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="12" r="9" />
          <path strokeLinecap="round" d="M3.6 9h16.8M3.6 15h16.8M12 3a17 17 0 010 18M12 3a17 17 0 000 18" />
        </svg>
        Online
      </span>
    );
  }
  if (channel === "sms_link") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700" title="Applied via texted link">
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
        </svg>
        SMS Link
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-teal-100 px-2.5 py-0.5 text-xs font-medium text-teal-700" title="Web">
      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
      </svg>
      Web
    </span>
  );
}

export default function ApplicationsPage() {
  const router = useRouter();
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const { totalPages, getSkip } = usePagination(totalCount, 25);

  const loadApplications = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams();
      params.set("skip", String(getSkip(page)));
      params.set("limit", "25");
      if (statusFilter) {
        params.set("status", statusFilter);
      }
      if (channelFilter) {
        params.set("channel", channelFilter);
      }

      const res = await fetch(`/api/applications?${params.toString()}`);
      if (!res.ok) {
        setError("Failed to load applications");
        setLoading(false);
        return;
      }

      const data = await res.json();
      setApplications(data.applications || []);
      setTotalCount(data.pagination?.total ?? data.total ?? 0);
    } catch {
      setError("Failed to load applications");
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, channelFilter, getSkip]);

  useEffect(() => {
    loadApplications();
  }, [loadApplications]);

  function handleStatusFilter(value: string) {
    setStatusFilter(value);
    setPage(1);
  }

  function handleChannelFilter(value: string) {
    setChannelFilter(value);
    setPage(1);
  }

  return (
    <DashboardShell>
      <div className="px-6 py-8 lg:px-8">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Applications</h1>
            <p className="mt-1 text-sm text-gray-500">
              View and manage all rental applications.
            </p>
          </div>
          <a
            href="/api/applications/export"
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Export CSV
          </a>
        </div>

        {/* Status Filter Chips */}
        <div className="mb-3 flex flex-wrap gap-2">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              onClick={() => handleStatusFilter(filter.value)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                statusFilter === filter.value
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50"
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {/* Channel Filter Chips */}
        <div className="mb-6 flex flex-wrap gap-2">
          {CHANNEL_FILTERS.map((filter) => (
            <button
              key={filter.value}
              onClick={() => handleChannelFilter(filter.value)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                channelFilter === filter.value
                  ? "bg-indigo-600 text-white"
                  : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50"
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-6 rounded-md bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-center">
              <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
              <p className="mt-3 text-sm text-gray-500">Loading applications...</p>
            </div>
          </div>
        ) : applications.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed border-gray-300 bg-white p-12 text-center">
            <h3 className="text-lg font-medium text-gray-900">No applications found</h3>
            <p className="mt-1 text-sm text-gray-500">
              {statusFilter
                ? "Try a different status filter."
                : "Applications will appear here when tenants apply."}
            </p>
          </div>
        ) : (
          <>
            {/* Table */}
            <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Name
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Property
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Phone
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Channel
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Date
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {applications.map((app) => (
                    <tr
                      key={app.id}
                      className="cursor-pointer transition-colors hover:bg-gray-50"
                      onClick={() => router.push(`/applications/${app.id}`)}
                    >
                      <td className="whitespace-nowrap px-6 py-4">
                        <Link
                          href={`/applications/${app.id}`}
                          className="text-sm font-medium text-gray-900 hover:text-blue-600"
                        >
                          {app.fullName || "Unknown"}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
                        {app.property.name}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-sm font-mono text-gray-500">
                        {app.callerPhone || "--"}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <ChannelLabel channel={app.channel} />
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <StatusBadge status={app.status} />
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
                        {formatDate(app.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="mt-6">
              <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
            </div>
          </>
        )}
      </div>
    </DashboardShell>
  );
}
