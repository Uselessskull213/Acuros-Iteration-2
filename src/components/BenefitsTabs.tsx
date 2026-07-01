'use client';

import { useState } from 'react';

const CLINICS = [
  {
    n: '01',
    t: 'Branded Patient Portal',
    d: 'White-labelled portal configured to your clinic - deployed same day, no EMR migration, no IT overhead.',
  },
  {
    n: '02',
    t: 'Clinic Dashboard',
    d: 'Monitor patient engagement, loyalty activity, and shop revenue from a single, clean dashboard built for clinicians.',
  },
  {
    n: '03',
    t: 'Loyalty & Rewards Engine',
    d: 'Patients earn points for portal activity, referrals, and check-ins - redeemable for clinic credits. Retention built-in.',
  },
  {
    n: '04',
    t: 'Clinic-Curated Shop',
    d: 'Products mapped to your specific treatments - not a generic catalogue. An extension of your clinical recommendations.',
  },
];

const PATIENTS = [
  {
    n: '01',
    t: 'AI Health Assistant',
    d: 'Evidence-based guidance 24/7. Translates labs, explains diagnoses, and prepares you for your next appointment.',
  },
  {
    n: '02',
    t: 'Appointment Preparation',
    d: 'AI-generated pre-visit briefs and question guides tailored to your health history and upcoming procedure.',
  },
  {
    n: '03',
    t: 'Secure Health Records',
    d: 'PIPEDA-compliant encrypted storage for your records, reports, and care history - private and always accessible.',
  },
  {
    n: '04',
    t: 'Procedure Bookings',
    d: 'Schedule consultations and treatments directly through your portal. Confirmed within one business day.',
  },
];

export default function BenefitsTabs() {
  const [tab, setTab] = useState<'clinics' | 'patients'>('clinics');
  const items = tab === 'clinics' ? CLINICS : PATIENTS;
  return (
    <div>
      <div className="tabs" role="tablist" aria-label="Benefits">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'clinics'}
          className={tab === 'clinics' ? 'active' : ''}
          onClick={() => setTab('clinics')}
        >
          For Clinics
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'patients'}
          className={tab === 'patients' ? 'active' : ''}
          onClick={() => setTab('patients')}
        >
          For Patients
        </button>
      </div>
      <div className="benefits" key={tab}>
        {items.map((it, i) => (
          <article className="benefit" style={{ animationDelay: `${i * 70}ms` }} key={it.n}>
            <span className="benefit-n">{it.n}</span>
            <h3>{it.t}</h3>
            <p>{it.d}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
