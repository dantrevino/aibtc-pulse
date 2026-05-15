#!/usr/bin/env node
import { execSync } from "node:child_process";

const GITHUB_API = "https://api.github.com";
const ROOT = process.cwd();

function getToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  if (fromEnv) return fromEnv;
  try {
    const stored = execSync("gh auth token 2>/dev/null", { encoding: "utf8", timeout: 5000 }).trim();
    if (stored) return stored;
  } catch {}
  return "";
}

function getAuthHeaders() {
  const token = getToken();
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "Allora-agent" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function curl(method, url, body) {
  const headers = getAuthHeaders();
  const args = ["-sS", "-X", method, url];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  if (body) args.push("-d", JSON.stringify(body));
  try {
    const out = execSync("curl " + args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(" "), {
      encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(out);
  } catch (e) {
    try { return JSON.parse(e.stdout); } catch { return { error: e.message }; }
  }
}

function api(method, path, body) {
  return curl(method, `${GITHUB_API}${path}`, body);
}

const cmd = process.argv[2];
const args = process.argv.slice(3);

switch (cmd) {
  case "issues":
  case "list-issues": {
    const [owner, repo, state] = [args[0], args[1], args[2] || "open"];
    const data = api("GET", `/repos/${owner}/${repo}/issues?state=${state}&per_page=20`);
    for (const issue of data) {
      console.log(`#${issue.number} [${issue.state}] ${issue.title}`);
      console.log(`  ${issue.html_url}`);
      console.log();
    }
    break;
  }
  case "prs":
  case "list-prs": {
    const [owner, repo, state] = [args[0], args[1], args[2] || "open"];
    const data = api("GET", `/repos/${owner}/${repo}/pulls?state=${state}&per_page=20`);
    for (const pr of data) {
      console.log(`#${pr.number} [${pr.state}] ${pr.title}`);
      console.log(`  ${pr.html_url}`);
      if (pr.user) console.log(`  Author: ${pr.user.login}`);
      console.log();
    }
    break;
  }
  case "comments":
  case "list-comments": {
    const [owner, repo, issueNumber] = args;
    const data = api("GET", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`);
    for (const c of data) {
      console.log(`--- ${c.user?.login} (${c.created_at}) ---`);
      console.log(c.body?.slice(0, 500));
      console.log();
    }
    break;
  }
  case "comment":
  case "add-comment": {
    const [owner, repo, issueNumber, ...bodyParts] = args;
    const body = bodyParts.join(" ");
    const data = api("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
    console.log(`Comment posted: ${data.html_url || "(failed)"}`);
    break;
  }
  case "notifications": {
    const data = api("GET", "/notifications");
    for (const n of data) {
      console.log(`[${n.reason}] ${n.repository?.full_name}: ${n.subject?.title}`);
      console.log(`  ${n.subject?.url}`);
      console.log();
    }
    if (data.length === 0) console.log("No notifications.");
    break;
  }
  case "releases":
  case "list-releases": {
    const [owner, repo] = args;
    const data = api("GET", `/repos/${owner}/${repo}/releases?per_page=10`);
    for (const r of data) {
      console.log(`${r.tag_name} (${r.published_at?.slice(0, 10)}): ${r.name}`);
      console.log(`  ${r.html_url}`);
      console.log();
    }
    break;
  }
  case "search":
  case "search-issues": {
    const query = args.join(" ");
    const data = api("GET", `/search/issues?q=${encodeURIComponent(query)}&per_page=10`);
    console.log(`Total results: ${data.total_count}`);
    for (const item of data.items || []) {
      console.log(`#${item.number} [${item.state}] ${item.title}`);
      console.log(`  ${item.html_url}`);
      console.log();
    }
    break;
  }
  case "token-status": {
    const token = getToken();
    if (!token) { console.log("NO_TOKEN: No GitHub token available"); process.exit(0); }
    const user = api("GET", "/user");
    if (user.login) console.log(`OK: Authenticated as ${user.login}`);
    else console.log(`INVALID: Token rejected — ${user.message || "unknown error"}`);
    break;
  }
  case "user":
  case "get-user": {
    const username = args[0] || "";
    const data = api("GET", username ? `/users/${username}` : "/user");
    console.log(JSON.stringify(data, null, 2));
    break;
  }
  case "get":
  case "api-get": {
    const path = args[0];
    if (!path) { console.error("Usage: gh-rest.mjs get /repos/owner/repo"); process.exit(1); }
    const data = api("GET", path);
    console.log(JSON.stringify(data, null, 2));
    break;
  }
  default:
    console.log(`Usage: node scripts/gh-rest.mjs <command> [args]

Commands:
  token-status                     Check if GitHub token is configured
  notifications                    List unread notifications
  issues <owner> <repo> [state]    List issues (state: open/closed/all)
  prs <owner> <repo> [state]       List pull requests
  comments <owner> <repo> <issue>  List comments on an issue/PR
  comment <owner> <repo> <issue> <text>  Add comment to issue/PR
  releases <owner> <repo>          List recent releases
  search <query>                   Search issues across GitHub
  user [username]                  Get user info
  get <api-path>                   Raw GET to GitHub API

Environment:
  GITHUB_TOKEN or GH_TOKEN  — personal access token
  If neither set, reads from 'gh auth token'
`);
    process.exit(1);
}
