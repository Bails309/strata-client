import { useEffect, useState } from 'react';
import { getAuditLogs, AuditLog } from '../api';

export default function AuditLogs() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [page, setPage] = useState(1);

  useEffect(() => {
    getAuditLogs(page).then(setLogs).catch(() => {});
  }, [page]);

  return (
    <div>
      <h1>Audit Logs</h1>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Timestamp</th>
              <th>Action</th>
              <th>User</th>
              <th>Details</th>
              <th>Hash</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td>{log.id}</td>
                <td className="text-[0.8rem]">{new Date(log.created_at).toLocaleString('en-GB')}</td>
                <td>
                  <span className="badge badge-success">{log.action_type}</span>
                </td>
                <td className="text-sm">
                  {log.username || (log.user_id ? log.user_id.slice(0, 8) : '—')}
                </td>
                <td className="text-[0.8rem] max-w-[300px] overflow-hidden text-ellipsis">
                  {JSON.stringify(log.details)}
                </td>
                <td className="font-mono text-[0.7rem] text-txt-secondary">
                  {log.current_hash.slice(0, 12)}…
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="flex justify-center gap-2 mt-4">
          <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="py-2 px-2 text-txt-secondary">Page {page}</span>
          <button className="btn" onClick={() => setPage(page + 1)} disabled={logs.length < 50}>
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
