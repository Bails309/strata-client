ALTER TABLE password_checkout_requests DROP CONSTRAINT password_checkout_requests_status_check;
ALTER TABLE password_checkout_requests ADD CONSTRAINT password_checkout_requests_status_check
  CHECK (status IN ('Pending', 'Approved', 'Active', 'Expired', 'Denied', 'CheckedIn'));
