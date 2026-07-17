/**
 * Bridges a Google Form to the Supabase "seat_attendance" table.
 *
 * SETUP
 * 1. Create a Google Form with these exact question titles (types shown):
 *      - "Room Name"      → Short answer
 *      - "Seat Number"    → Short answer
 *      - "Occupant Name"  → Short answer (optional to fill)
 *      - "Present?"       → Multiple choice: "Yes" / "No"
 *      - "Note"           → Short answer (optional, paragraph is fine too)
 *    (Question titles must match exactly — that's how this script finds them.
 *    Add/remove/reword other questions freely; only these five are read.)
 *
 * 2. Open the Form → the three-dot menu → Script editor (or: Extensions →
 *    Apps Script from the linked Google Sheet). Delete any starter code and
 *    paste this whole file in.
 *
 * 3. Fill in SUPABASE_URL and SUPABASE_ANON_KEY below — same values as in
 *    this project's src/App.jsx (or your own Supabase project's Settings → API).
 *
 * 4. In the Apps Script editor: Triggers (clock icon, left sidebar) → Add
 *    Trigger → choose function "onFormSubmit", event source "From form",
 *    event type "On form submit" → Save. Grant the permissions it asks for.
 *
 * That's it — every new form response now creates a row in seat_attendance.
 * Open the app's "Attendance" tab to see them.
 */

const SUPABASE_URL = "https://chhxglvujlsdlyrfyeel.supabase.co"; // <-- your project URL
const SUPABASE_ANON_KEY = "PASTE_YOUR_ANON_KEY_HERE"; // <-- your anon/public key

function onFormSubmit(e) {
  const answers = {};
  e.response.getItemResponses().forEach((item) => {
    answers[item.getItem().getTitle().trim()] = item.getResponse();
  });

  const payload = {
    room_name: answers["Room Name"] || "",
    seat_number: answers["Seat Number"] || "",
    occupant: answers["Occupant Name"] || null,
    present: (answers["Present?"] || "").toString().trim().toLowerCase() === "yes",
    note: answers["Note"] || null,
    source: "google_form",
  };

  const res = UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/seat_attendance`, {
    method: "post",
    contentType: "application/json",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      Prefer: "return=minimal",
    },
    payload: JSON.stringify([payload]),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() >= 300) {
    // Shows up in Apps Script → Executions if a submission fails to save,
    // e.g. wrong anon key or the table hasn't been created yet.
    console.error("Supabase insert failed: " + res.getContentText());
  }
}
