import { PROJECT } from '../config/project.config';

export interface HealthCheckResult {
  frontendOk: boolean;
  backendOk: boolean;
  frontendError?: string;
  backendError?: string;
}

const FRONTEND_BASE_URL = PROJECT.frontendUrl;
const BACKEND_BASE_URL = PROJECT.backendUrl;

/** Pre-flight check that both this project's services are up. */
export async function checkServicesHealth(): Promise<HealthCheckResult> {
  const result: HealthCheckResult = {
    frontendOk: false,
    backendOk: false,
  };

  // Check Frontend
  try {
    const res = await fetch(`${FRONTEND_BASE_URL}/`, {
      signal: AbortSignal.timeout(3000),
    });
    result.frontendOk = res.ok || res.status < 500;
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    result.frontendError = errMessage || `Connection refused on ${FRONTEND_BASE_URL}`;
  }

  // Check Backend
  try {
    const res = await fetch(`${BACKEND_BASE_URL}${PROJECT.backendHealthPath}`, {
      signal: AbortSignal.timeout(3000),
    });
    result.backendOk = res.ok || res.status < 500;
  } catch (err: unknown) {
    // Fallback check to /docs or root
    try {
      const resDocs = await fetch(`${BACKEND_BASE_URL}/docs`, {
        signal: AbortSignal.timeout(2000),
      });
      result.backendOk = resDocs.ok || resDocs.status < 500;
    } catch {
      const errMessage = err instanceof Error ? err.message : String(err);
      result.backendError = errMessage || `Connection refused on ${BACKEND_BASE_URL}`;
    }
  }

  return result;
}

/** Automatically analyzes error messages and produces actionable diagnostic guidance */
export function diagnoseError(error: unknown, context?: string): string {
  const errStr =
    error instanceof Error ? error.message : String(error ?? 'Unknown error');

  const backendPort = new URL(PROJECT.backendUrl).port;
  const frontendPort = new URL(PROJECT.frontendUrl).port;

  if (errStr.includes('ECONNREFUSED') || errStr.includes('Failed to fetch')) {
    if (errStr.includes(backendPort) || context?.includes('backend')) {
      return (
        `🔴 [Agent Backend Offline]: ${PROJECT.backendUrl} is not reachable.\n` +
        `   👉 Fix: ${PROJECT.backendStartCmd}`
      );
    }
    if (errStr.includes(frontendPort) || context?.includes('frontend')) {
      return (
        `🔴 [Frontend Offline]: ${PROJECT.frontendUrl} is not reachable.\n` +
        `   👉 Fix: ${PROJECT.frontendStartCmd}`
      );
    }
  }

  if (errStr.includes('Timeout') && errStr.includes('waitFor')) {
    return (
      '⚠️ [UI Selector Timeout]: Playwright timed out waiting for an expected element on screen.\n' +
      '   👉 Fix: Verify that the route loaded correctly and the button/input exists in the DOM.'
    );
  }

  if (
    errStr.includes('CopilotKit core not attached') ||
    errStr.includes('CopilotKitProvider')
  ) {
    return (
      '⚠️ [CopilotKit Provider Issue]: CopilotKit components require a wrapping CopilotKitProvider.\n' +
      '   👉 Fix: Check `frontend/src/components/providers.tsx`.'
    );
  }

  if (errStr.includes('404') || errStr.includes('Not Found')) {
    return (
      `⚠️ [Route Not Found (404)]: The requested URL could not be found.\n` +
      `   👉 Fix: Ensure the page route exists in \`frontend/src/app/\`.`
    );
  }

  return `ℹ️ [Diagnostic Note]: ${errStr}`;
}
