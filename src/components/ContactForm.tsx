'use client';

import { useEffect, useRef, useState } from 'react';

/* Same wire contract as the legacy form: POST /api/contact with
 * { name, clinic, email, type, message, ts } + honeypot abort. */
export default function ContactForm() {
  const [status, setStatus] = useState<'idle' | 'sending' | 'ok' | 'err'>('idle');
  const [error, setError] = useState('');
  const tsRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (tsRef.current) tsRef.current.value = String(Date.now());
  }, []);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    if (String(data.get('company') || '')) return; // honeypot
    setStatus('sending');
    setError('');
    try {
      const resp = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: String(data.get('name') || ''),
          clinic: String(data.get('clinic') || ''),
          email: String(data.get('email') || ''),
          type: String(data.get('type') || ''),
          message: String(data.get('message') || ''),
          ts: String(data.get('ts') || ''),
        }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error((body as { error?: string }).error || 'Submission failed');
      setStatus('ok');
      form.reset();
      if (tsRef.current) tsRef.current.value = String(Date.now());
    } catch (err) {
      setStatus('err');
      setError(err instanceof Error ? err.message : 'Connection failed. Please try again.');
    }
  };

  return (
    <form className="ct-form" onSubmit={submit} noValidate={false}>
      <div className="ct-row">
        <label className="ct-field">
          <span>Your name</span>
          <input name="name" type="text" placeholder="Jane Mossbridge" maxLength={100} required autoComplete="name" />
        </label>
        <label className="ct-field">
          <span>Clinic / Organization</span>
          <input name="clinic" type="text" placeholder="Your Clinic Name" maxLength={120} autoComplete="organization" />
        </label>
      </div>
      <div className="ct-row">
        <label className="ct-field">
          <span>Email address</span>
          <input name="email" type="email" placeholder="name@clinic.com" maxLength={160} required autoComplete="email" />
        </label>
        <label className="ct-field">
          <span>Inquiry type</span>
          <select name="type" defaultValue="Book a Demo">
            <option>Book a Demo</option>
            <option>Clinic Onboarding</option>
            <option>Pricing Inquiry</option>
            <option>Partnership</option>
            <option>General Inquiry</option>
          </select>
        </label>
      </div>
      <label className="ct-field">
        <span>Message</span>
        <textarea
          name="message"
          rows={4}
          maxLength={4000}
          required
          placeholder="Tell us about your practice and what you're looking to achieve…"
        />
      </label>

      {/* honeypot */}
      <div className="ct-hp" aria-hidden="true">
        <label>
          Company
          <input name="company" type="text" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <input ref={tsRef} name="ts" type="hidden" defaultValue="" />

      {status === 'ok' && (
        <p className="ct-ok" role="status">
          Message sent. We&rsquo;ll be in touch within one business day.
        </p>
      )}
      {status === 'err' && (
        <p className="ct-err" role="alert">
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-solid btn-lg ct-submit" disabled={status === 'sending'}>
        {status === 'sending' ? 'Sending…' : 'Send Message'}
      </button>
    </form>
  );
}
