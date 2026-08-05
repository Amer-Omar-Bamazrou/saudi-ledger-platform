-- M12.2 · Saudi National Address fields required by the ZATCA schematron.
--
-- Both were found by running ZATCA's OWN validator against generated XML, not
-- by reading the spec — and one of them is invisible in the rule text.
--
--   companies.additional_number  (KSA-23, cbc:PlotIdentification)
--     BR-KSA-09, seller address. Flagged `warning`.
--
--   customers.additional_number  (buyer mirror, not itself required)
--   customers.province           (BT-54, cbc:CountrySubentity)
--     BR-KSA-10, buyer address. Flagged **error** — blocks standard (B2B)
--     invoices. Its message names only street/city/postal/country, but the
--     actual assertion ALSO requires cbc:CountrySubentity and
--     cbc:CitySubdivisionName. Trusting the message would have left standard
--     invoices failing validation with no obvious cause.
--
-- Not required for SIMPLIFIED (B2C) invoices — BR-KSA-10 exempts them, which
-- is why all of these stay nullable and are validated per document type.

ALTER TABLE "customers" ADD COLUMN "additional_number" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "province" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "additional_number" varchar(10);
