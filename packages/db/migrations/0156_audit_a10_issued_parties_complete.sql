-- ═════════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 audit (2026-11-09), finding A10 — G50's sibling: the capture holds
-- EVERY party field the signed e-invoice states.
--
-- T1c (0133) captures at issue the parties an issued document PRINTS. The signed
-- XML states a few more: the seller's additional number, and the buyer's
-- additional number, province, country and national id. Those were read live by
-- the e-invoice loader AFTER the issuing write, together with the rest of the
-- buyer block and the seller's CR and address — so an edit committed in between
-- made the signed, submitted document disagree with the invoice's own capture.
-- The loader now reads the capture only; here the capture gains the fields it
-- lacked. Same keys as `services/issuedParties.ts` (the issuing write's own
-- capture), which the 0133 trigger compares key by key at issue.
--
-- 🔴 NEVER ALTERS AN ISSUED ROW: an issued invoice keeps the capture it was
-- issued with (0133's trigger refuses any change to it). Only issuances after
-- this migration carry the new keys.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION invoice_seller_capture(company uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $fn$
  SELECT jsonb_build_object('nameAr', c.name_ar, 'crNumber', c.cr_number, 'buildingNumber', c.building_number, 'street', c.street,
                            'district', c.district, 'city', c.city, 'postalCode', c.postal_code, 'logoPath', c.logo_path,
                            'additionalNumber', c.additional_number)
    FROM companies c WHERE c.id = company
$fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION invoice_buyer_capture(customer integer) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $fn$
  SELECT jsonb_build_object('name', c.name, 'nameAr', c.name_ar, 'vatNumber', c.tax_number, 'crNumber', c.cr_number,
                            'buildingNumber', c.building_number, 'street', c.street, 'district', c.district, 'city', c.city,
                            'postalCode', c.postal_code, 'additionalNumber', c.additional_number, 'province', c.province,
                            'country', c.country, 'nationalId', c.national_id)
    FROM customers c WHERE c.id = customer
$fn$;
