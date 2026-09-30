import { useCallback, useEffect, useState } from 'react';
import { QrCode, QrScanner } from './QrCode';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

type Code = { code: string; expiresAt: number };
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'KindredHours' }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'QR request failed.');
  return result as T;
}

export function AttendanceQr({ eventId, staff, onUpdate }: { eventId?: string; staff?: boolean; onUpdate: () => Promise<void> }) {
  const [credential, setCredential] = useState<Code | null>(null);
  const [action, setAction] = useState<'in'|'out'>('in');
  const [remaining, setRemaining] = useState(0);
  const load = useCallback(async () => {
    if (staff && !eventId) { setCredential(null); return; }
    try { setCredential(await api<Code>(staff ? `/api/qr/event/${eventId}` : '/api/qr/member')); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Could not load QR code.'); }
  }, [eventId, staff]);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 60000); return () => window.clearInterval(timer); }, [load]);
  useEffect(() => { const timer = window.setInterval(() => setRemaining(Math.max(0, Math.ceil(((credential?.expiresAt ?? 0) - Date.now()) / 1000))), 1000); return () => window.clearInterval(timer); }, [credential]);
  const submit = async (code: string) => {
    try {
      const result = await api<{ outcome: string }>('/api/qr/attendance', { code, action, ...(staff ? { eventId: Number(eventId) } : {}) });
      toast.success(result.outcome === 'already' ? 'Attendance was already recorded.' : action === 'in' ? 'Checked in successfully.' : 'Checked out successfully.');
      await onUpdate();
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Unable to record attendance.'); }
  };
  return <div className="space-y-5">
    <p className="text-sm leading-6 text-[#627468]">{staff ? 'Show this event QR to registered volunteers, or scan a member QR to assist them.' : 'Show your member QR to staff, or scan the event QR at the venue. You must be registered to scan an event QR.'}</p>
    {credential && <div className="flex flex-col items-center rounded-3xl bg-[#f3f6ef] p-5"><QrCode value={credential.code} label={staff ? 'Short-lived event attendance QR code' : 'Short-lived member attendance QR code'} /><span className="mt-2 text-xs font-semibold text-[#627468]">Refreshes automatically · expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</span><Button type="button" variant="ghost" size="sm" onClick={() => void load()}>Refresh code now</Button></div>}
    {staff && !eventId && <p className="text-sm text-[#a33c32]">Select an event in the attendance form to show its QR or scan a member's code.</p>}
    <div className="flex gap-2" role="group" aria-label="QR attendance action"><Button type="button" variant={action === 'in' ? 'default' : 'outline'} className="rounded-full" onClick={() => setAction('in')}>Check in</Button><Button type="button" variant={action === 'out' ? 'default' : 'outline'} className="rounded-full" onClick={() => setAction('out')}>Check out</Button></div>
    {(!staff || eventId) && <QrScanner onCode={code => void submit(code)} />}
  </div>;
}
