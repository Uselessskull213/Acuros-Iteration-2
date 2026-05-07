-- ============================================================
-- Optional: seed Anti-Aging Academic Clinic into the new dynamic
-- model. Run only if you want /c/aaa-clinics to render alongside
-- the existing /aaaclinics-portal.
--
-- Idempotent on slug='aaa-clinics'. Owner_id is left NULL — claim
-- it later by signing in as the owner and updating manually:
--   update organizations set owner_id = auth.uid() where slug='aaa-clinics';
-- ============================================================

INSERT INTO public.organizations
  (name, slug, specialty, description, location, contact_email,
   theme, brand, is_published, published_at, active)
VALUES (
  'Anti-Aging Academic Clinic',
  'aaa-clinics',
  'Aesthetics & Anti-Aging Medicine',
  'A medical aesthetics clinic combining clinical expertise with curated treatments. Injectables, skin therapy, IV wellness, and a clinic-grade product shop.',
  'Toronto, ON',
  'info@aaaclinics.com',
  jsonb_build_object('accent', '#c9a96e'),
  jsonb_build_object('tagline', 'Considered aesthetic care.', 'voice', 'Premium'),
  true,
  now(),
  true
)
ON CONFLICT (lower(slug)) DO UPDATE SET
  specialty   = EXCLUDED.specialty,
  description = EXCLUDED.description,
  location    = EXCLUDED.location,
  is_published = true;

-- Seed a starter set of services so the page is not empty on first load.
WITH org AS (SELECT id FROM public.organizations WHERE slug = 'aaa-clinics' LIMIT 1)
INSERT INTO public.clinic_services (org_id, name, category, duration_min, price_cents, description, sort_order)
SELECT org.id, x.name, x.category, x.duration_min, x.price_cents, x.description, x.sort_order
FROM org, (VALUES
  ('Botox Consultation',        'Injectables', 30,   0,     'Personalised assessment for neuromodulator treatment.',                         0),
  ('Dermal Filler — 1ml',       'Injectables', 60,   65000, 'Hyaluronic acid filler for facial contouring and volume restoration.',          1),
  ('Microneedling',             'Skin',        75,   45000, 'Collagen induction therapy with optional growth-factor serum.',                 2),
  ('Chemical Peel',             'Skin',        45,   28000, 'Medical-grade exfoliation for tone, texture, and pigmentation.',                3),
  ('IV Vitamin Therapy',        'Wellness',    60,   22000, 'Intravenous nutrient infusion calibrated to your bloodwork.',                   4),
  ('Initial Aesthetic Consult', 'Consultation',45,   15000, 'Full skin and aesthetic assessment with a written treatment roadmap.',          5)
) AS x(name, category, duration_min, price_cents, description, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.clinic_services s WHERE s.org_id = org.id AND s.name = x.name);
