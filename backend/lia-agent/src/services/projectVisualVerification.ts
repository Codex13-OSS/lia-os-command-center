import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, resolve, sep } from "node:path";

import { resolveProjectCodexWorkspace } from "./projectCodexWorkspace.js";

const VISUAL_QA_PROJECTS = new Set([
  "lia-hermes-mobile-preview",
]);

const CHROME_EXECUTABLE = "/usr/bin/google-chrome";
const ARTIFACT_ROOT = "/tmp/lia-visual-qa-artifacts";
const CHROME_TIMEOUT_MS = 45_000;
const MAX_BROWSER_OUTPUT_BYTES = 2 * 1024 * 1024;

type VisualViewport = {
  id: "iphone" | "ipad" | "desktop";
  width: number;
  height: number;
  mobile: boolean;
};

const VIEWPORTS: readonly VisualViewport[] = [
  { id: "iphone", width: 390, height: 844, mobile: true },
  { id: "ipad", width: 820, height: 1180, mobile: true },
  { id: "desktop", width: 1440, height: 900, mobile: false },
];

type VisualBrowserEvidence = {
  viewport: string;
  width: number;
  height: number;
  appLoaded: boolean;
  horizontalOverflow: boolean;
  primaryNavigationCount: number;
  knownNavigationItems: number;
  undersizedNavigationTargets: number;
  criticalNavigationOutsideViewport: number;
  readableBaseFont: boolean;
  contentUsesViewport: boolean;
  navigationInteractionFailures: number;
};

export type ProjectVisualVerificationResult =
  | {
      success: true;
      executionId: string;
      status: "visual_verified";
      checksPassed: number;
      totalChecks: number;
      summary: string;
    }
  | {
      success: false;
      executionId: string;
      status: "visual_verification_failed";
      error: "visual_verification_unavailable" | "visual_check_failed" | "visual_check_timeout";
      failedCheckId?: string;
      checksPassed: number;
      totalChecks: number;
      summary: string;
    };

export type ProjectVisualVerificationExecutor = (
  projectId: string,
  executionId: string,
) => Promise<ProjectVisualVerificationResult>;

export function projectRequiresVisualVerification(projectId: string): boolean {
  return VISUAL_QA_PROJECTS.has(projectId);
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

function visualHarnessHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body,#qa-frame{margin:0;width:100%;height:100%;border:0;overflow:hidden}
#qa-frame{display:block}
</style>
</head>
<body>
<iframe id="qa-frame" src="/"></iframe>
<script>
(() => {
  const frame = document.getElementById("qa-frame");

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const visible = (win, element) => {
    if (!(element instanceof win.HTMLElement)) return false;
    const style = win.getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity || "1") === 0
    ) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const normalizedText = (element) =>
    (element.textContent || "").replace(/\\s+/g, " ").trim();

  const knownLabels = new Set(["Inicio", "Agenda", "Proyectos"]);

  const clickableKnownItems = (win, doc) =>
    Array.from(doc.querySelectorAll('a,button,[role="button"]'))
      .filter((element) => visible(win, element))
      .filter((element) => knownLabels.has(normalizedText(element)));

  const nearestPrimaryContainer = (win, item) => {
    let current = item.parentElement;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      const known = Array.from(
        current.querySelectorAll('a,button,[role="button"]')
      ).filter((candidate) =>
        visible(win, candidate) && knownLabels.has(normalizedText(candidate))
      );
      if (known.length >= 2) return current;
    }
    return null;
  };

  const run = async () => {
    let result = {
      appLoaded: false,
      horizontalOverflow: true,
      primaryNavigationCount: 0,
      knownNavigationItems: 0,
      undersizedNavigationTargets: 0,
      criticalNavigationOutsideViewport: 0,
      readableBaseFont: false,
      contentUsesViewport: false,
      navigationInteractionFailures: 0
    };

    try {
      await wait(1200);

      const win = frame.contentWindow;
      const doc = frame.contentDocument;

      if (!win || !doc) throw new Error("frame_unavailable");

      // The preview starts at the local deterministic login screen.
      // Authenticate only inside this isolated browser session before measuring
      // the executive UI. Credentials never leave this in-memory QA context and
      // are never returned in evidence, receipts or diagnostics.
      const loginEmail = doc.querySelector('input[type="email"]');
      const loginPassword = doc.querySelector('input[type="password"]');
      const loginButton = Array.from(doc.querySelectorAll("button"))
        .find((button) =>
          (button.textContent || "").replace(/\\s+/g, " ").trim() === "Iniciar sesión"
        );

      if (loginEmail && loginPassword && loginButton) {
        const setNativeValue = (element, value) => {
          const prototype = Object.getPrototypeOf(element);
          const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
          descriptor?.set?.call(element, value);
          element.dispatchEvent(new win.Event("input", { bubbles: true }));
          element.dispatchEvent(new win.Event("change", { bubbles: true }));
        };

        setNativeValue(loginEmail, "ejecutivo@lia.local");
        setNativeValue(loginPassword, "lia2026");
        loginButton.click();
        await wait(700);
      }

      const root = doc.getElementById("root");
      const bodyText = (doc.body?.innerText || "").trim();

      result.appLoaded = Boolean(root && bodyText.length > 20);

      const docElement = doc.documentElement;
      result.horizontalOverflow =
        docElement.scrollWidth > win.innerWidth + 2;

      const items = clickableKnownItems(win, doc);
      result.knownNavigationItems = items.length;

      const containers = [];
      for (const item of items) {
        const container = nearestPrimaryContainer(win, item);
        if (container && !containers.includes(container)) {
          containers.push(container);
        }
      }

      const minimalContainers = containers.filter((candidate) =>
        !containers.some(
          (other) =>
            other !== candidate &&
            candidate.contains(other)
        )
      );

      result.primaryNavigationCount = minimalContainers.length;

      for (const item of items) {
        const rect = item.getBoundingClientRect();

        if (rect.width < 44 || rect.height < 44) {
          result.undersizedNavigationTargets += 1;
        }

        if (
          rect.left < -2 ||
          rect.top < -2 ||
          rect.right > win.innerWidth + 2 ||
          rect.bottom > win.innerHeight + 2
        ) {
          result.criticalNavigationOutsideViewport += 1;
        }
      }

      const bodyStyle = win.getComputedStyle(doc.body);
      const fontSize = Number.parseFloat(bodyStyle.fontSize || "0");
      result.readableBaseFont = Number.isFinite(fontSize) && fontSize >= 12;

      const rootRect = root?.getBoundingClientRect();
      result.contentUsesViewport = Boolean(
        rootRect &&
        rootRect.width >= Math.min(win.innerWidth * 0.82, win.innerWidth - 12)
      );

      for (const label of ["Inicio", "Agenda", "Proyectos"]) {
        const before = (doc.body?.innerText || "").length;
        const target = clickableKnownItems(win, doc)
          .find((item) => normalizedText(item) === label);

        if (!target) {
          result.navigationInteractionFailures += 1;
          continue;
        }

        try {
          target.click();
          await wait(180);

          const after = (doc.body?.innerText || "").length;
          if (after < 20 || before < 20) {
            result.navigationInteractionFailures += 1;
          }
        } catch {
          result.navigationInteractionFailures += 1;
        }
      }
    } catch {
      result.appLoaded = false;
    }

    document.body.setAttribute(
      "data-lia-visual-qa",
      encodeURIComponent(JSON.stringify(result))
    );
  };

  frame.addEventListener("load", () => {
    void run();
  }, { once: true });
})();
</script>
</body>
</html>`;
}

async function startStaticPreview(distRoot: string): Promise<{
  server: Server;
  origin: string;
}> {
  await access(resolve(distRoot, "index.html"));

  const harness = visualHarnessHtml();

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(
        request.url ?? "/",
        "http://127.0.0.1",
      );

      if (requestUrl.pathname === "/__lia_visual_qa__") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(harness);
        return;
      }

      let pathname = decodeURIComponent(requestUrl.pathname);
      if (pathname === "/") pathname = "/index.html";

      const candidate = resolve(distRoot, `.${pathname}`);
      if (
        candidate !== distRoot &&
        !candidate.startsWith(`${distRoot}${sep}`)
      ) {
        response.writeHead(404);
        response.end("not found");
        return;
      }

      try {
        const data = await readFile(candidate);
        response.writeHead(200, {
          "content-type": contentType(candidate),
          "cache-control": "no-store",
        });
        response.end(data);
        return;
      } catch {
        const fallback = await readFile(resolve(distRoot, "index.html"));
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(fallback);
      }
    } catch {
      response.writeHead(500);
      response.end("preview unavailable");
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("visual_preview_port_unavailable");
  }

  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  });
}

async function runChrome(
  origin: string,
  viewport: VisualViewport,
  screenshotPath: string,
  userDataDir: string,
): Promise<VisualBrowserEvidence> {
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    `--user-data-dir=${userDataDir}`,
    `--window-size=${viewport.width},${viewport.height}`,
    "--virtual-time-budget=6000",
    `--screenshot=${screenshotPath}`,
    "--dump-dom",
    `${origin}/__lia_visual_qa__`,
  ];

  return await new Promise<VisualBrowserEvidence>((resolveResult, rejectResult) => {
    const child = spawn(CHROME_EXECUTABLE, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/root",
      },
    });

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let finished = false;

    const terminate = () => {
      if (!child.killed) child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1_000).unref();
    };

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      terminate();
      rejectResult(new Error("visual_browser_timeout"));
    }, CHROME_TIMEOUT_MS);
    timer.unref();

    const capture = (chunk: Buffer, target: "stdout" | "stderr") => {
      if (finished) return;
      outputBytes += chunk.length;

      if (outputBytes > MAX_BROWSER_OUTPUT_BYTES) {
        finished = true;
        clearTimeout(timer);
        terminate();
        rejectResult(new Error("visual_browser_output_limit"));
        return;
      }

      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk: Buffer) => capture(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, "stderr"));

    child.once("error", () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      rejectResult(new Error("visual_browser_unavailable"));
    });

    child.once("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0) {
        void stderr;
        rejectResult(new Error("visual_browser_failed"));
        return;
      }

      const match = stdout.match(
        /data-lia-visual-qa="([^"]+)"/,
      );

      if (!match?.[1]) {
        rejectResult(new Error("visual_browser_evidence_missing"));
        return;
      }

      try {
        const evidence = JSON.parse(
          decodeURIComponent(match[1]),
        ) as Omit<VisualBrowserEvidence, "viewport" | "width" | "height">;

        resolveResult({
          viewport: viewport.id,
          width: viewport.width,
          height: viewport.height,
          ...evidence,
        });
      } catch {
        rejectResult(new Error("visual_browser_evidence_invalid"));
      }
    });
  });
}

function evidenceChecks(
  viewport: VisualViewport,
  evidence: VisualBrowserEvidence,
): Array<{ id: string; passed: boolean }> {
  const checks = [
    {
      id: `${viewport.id}:app_loaded`,
      passed: evidence.appLoaded,
    },
    {
      id: `${viewport.id}:no_horizontal_overflow`,
      passed: !evidence.horizontalOverflow,
    },
    {
      id: `${viewport.id}:navigation_present`,
      passed: evidence.knownNavigationItems >= 3,
    },
    {
      id: `${viewport.id}:navigation_functional`,
      passed: evidence.navigationInteractionFailures === 0,
    },
    {
      id: `${viewport.id}:readable_base_font`,
      passed: evidence.readableBaseFont,
    },
    {
      id: `${viewport.id}:content_uses_viewport`,
      passed: evidence.contentUsesViewport,
    },
  ];

  if (viewport.mobile) {
    checks.push(
      {
        id: `${viewport.id}:single_primary_navigation`,
        passed: evidence.primaryNavigationCount === 1,
      },
      {
        id: `${viewport.id}:touch_targets`,
        passed: evidence.undersizedNavigationTargets === 0,
      },
      {
        id: `${viewport.id}:critical_nav_inside_viewport`,
        passed: evidence.criticalNavigationOutsideViewport === 0,
      },
    );
  }

  return checks;
}

export const verifyProjectVisualWorkspace: ProjectVisualVerificationExecutor =
  async (projectId, executionId) => {
    if (!projectRequiresVisualVerification(projectId)) {
      return {
        success: true,
        executionId,
        status: "visual_verified",
        checksPassed: 0,
        totalChecks: 0,
        summary: "Visual verification is not required for this project.",
      };
    }

    const workspace = resolveProjectCodexWorkspace(executionId);
    if (!workspace.success) {
      return {
        success: false,
        executionId,
        status: "visual_verification_failed",
        error: "visual_verification_unavailable",
        checksPassed: 0,
        totalChecks: 0,
        summary: "Visual verification workspace is unavailable.",
      };
    }

    const distRoot = resolve(workspace.worktreePath, "frontend", "dist");
    const artifactDirectory = resolve(ARTIFACT_ROOT, executionId);

    let server: Server | undefined;
    let temporaryRoot: string | undefined;

    try {
      await access(CHROME_EXECUTABLE);
      await access(resolve(distRoot, "index.html"));
      await mkdir(artifactDirectory, { recursive: true });

      const preview = await startStaticPreview(distRoot);
      server = preview.server;

      temporaryRoot = await mkdtemp(
        resolve(tmpdir(), "lia-visual-qa-"),
      );

      const allChecks: Array<{ id: string; passed: boolean }> = [];

      for (const viewport of VIEWPORTS) {
        const viewportProfile = resolve(
          temporaryRoot,
          `chrome-${viewport.id}`,
        );
        await mkdir(viewportProfile, { recursive: true });

        const screenshotPath = resolve(
          artifactDirectory,
          `${viewport.id}.png`,
        );

        const evidence = await runChrome(
          preview.origin,
          viewport,
          screenshotPath,
          viewportProfile,
        );

        allChecks.push(...evidenceChecks(viewport, evidence));
      }

      const checksPassed = allChecks.filter((check) => check.passed).length;
      const failedCheck = allChecks.find((check) => !check.passed);

      if (failedCheck) {
        return {
          success: false,
          executionId,
          status: "visual_verification_failed",
          error: "visual_check_failed",
          failedCheckId: failedCheck.id,
          checksPassed,
          totalChecks: allChecks.length,
          summary: "Deterministic browser visual verification failed.",
        };
      }

      return {
        success: true,
        executionId,
        status: "visual_verified",
        checksPassed,
        totalChecks: allChecks.length,
        summary: "Deterministic browser visual verification passed.",
      };
    } catch (error) {
      const timedOut = error instanceof Error && error.message === "visual_browser_timeout";
      return {
        success: false,
        executionId,
        status: "visual_verification_failed",
        error: timedOut ? "visual_check_timeout" : "visual_verification_unavailable",
        checksPassed: 0,
        totalChecks: 0,
        summary: timedOut
          ? "Deterministic browser visual verification timed out."
          : "Deterministic browser visual verification is unavailable.",
      };
    } finally {
      if (server) {
        try {
          await closeServer(server);
        } catch {
          // Visual result remains fail-closed independently of cleanup reporting.
        }
      }

      if (temporaryRoot) {
        try {
          await rm(temporaryRoot, { recursive: true, force: true });
        } catch {
          // Temporary browser profile contains no authoritative result.
        }
      }
    }
  };
