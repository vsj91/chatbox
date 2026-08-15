Deployment and Supabase setup

1) Create a Supabase project.
2) Open SQL editor and run ephemeral-chat-schema.sql.
3) Enable Row Level Security (RLS) on tables and add policies. Minimal example for demo:
   - Allow INSERT on waiting, participants, messages for authenticated users or via anon if you accept public usage.
   - For production, require Supabase Auth and strict RLS.

Example RLS (demo only):
  -- allow public inserts to messages (demo)
  ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "public_insert_messages" ON messages FOR INSERT USING (true);
  CREATE POLICY "public_select_messages" ON messages FOR SELECT USING (true);

4) In index.html edit SUPABASE_URL and SUPABASE_KEY (anon key).
5) Create a GitHub repo, commit these files, and enable GitHub Pages (branch: main, folder: root) or push build to gh-pages branch.

Notes:
- This client uses anon key in browser; for tighter security use Edge Functions as a proxy and keep service_role secret server-side.
- Cleanup: the schema attempts to delete rooms when participants leave. Network crashes may leave stale waiting rows; you can periodically purge old waiting entries via a scheduled job.

Want a ready ZIP or a push-to-GitHub helper script next?