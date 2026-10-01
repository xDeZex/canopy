// The contract for readers and writers of the file, kept in the file itself so
// an agent opening it needs no other document. Saving rewrites the whole file,
// so every save emits it again.
export const COMMENTS_HEADER = `Canopy review comments (version 1). Append a message to a thread to reply.
Schema:
  version: 1
  threads:
    - id: thread-1                  # stable, unique in the file
      file: src/example.js          # relative path; no '..', '.', empty, absolute, ':' or '\\' parts
      side: modified                # only the modified side is supported
      line_range: {start: 2, end: 3}  # inclusive, 1-based; a single line has start == end
      created_at: "2026-10-01T12:00:00Z"
      resolved: false
      messages:                     # at least one; unique ids within the thread
        - id: message-1             # stable
          author: user              # user | agent
          text: Please explain this change.   # plain text, never Markdown or HTML
          created_at: "2026-10-01T12:00:00Z"
A thread not tied to a file may omit file, side and line_range together (never use null).
Unknown fields, duplicate ids, other versions and non-core YAML tags make Canopy refuse
the whole file with a visible warning. IDs and created_at values must never change.
To reply, append a message with author: agent. A reply does not change resolved; set
resolved: true only when the same edit also adds an agent response.
Writing from outside Canopy: reread the file immediately before changing it, change only
what you mean to, write the result to a temporary file in this directory and atomically
rename it over comments.yaml. Never edit in place.
Canopy rewrites the whole file on save, so hand-added comments other than this header are lost.`
  .split('\n').map((line) => `# ${line}`).join('\n');
