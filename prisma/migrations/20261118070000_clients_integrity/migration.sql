-- A card has a name, as a booking's snapshot does (appointments_client_name).
ALTER TABLE "clients"
  ADD CONSTRAINT "clients_name" CHECK (length(btrim("name")) > 0);

-- A guardian is always a holder, and a holder with dependents keeps their phone: what no CHECK
-- or foreign key can say, because it is about two rows. FOR SHARE on the guardian makes «add a
-- dependent» and «take the guardian's phone away» take turns instead of both passing.
CREATE FUNCTION clients_guardian_is_holder() RETURNS trigger AS $$
DECLARE
  guardian_phone TEXT;
BEGIN
  -- No such guardian in this business: the foreign key says so, in its own words.
  IF NEW.guardian_id IS NOT NULL THEN
    SELECT phone INTO guardian_phone FROM clients
    WHERE business_id = NEW.business_id AND id = NEW.guardian_id FOR SHARE;
    IF FOUND AND guardian_phone IS NULL THEN
      RAISE EXCEPTION 'client % is not an account holder, so cannot be a guardian', NEW.guardian_id
        USING ERRCODE = '23514', CONSTRAINT = 'clients_guardian_is_holder';
    END IF;
  END IF;
  IF NEW.phone IS NULL AND TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM clients WHERE business_id = NEW.business_id AND guardian_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'client % has dependents, so keeps a phone', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'clients_guardian_is_holder';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "clients_guardian_is_holder"
  BEFORE INSERT OR UPDATE OF "guardian_id", "phone" ON "clients"
  FOR EACH ROW EXECUTE FUNCTION clients_guardian_is_holder();
