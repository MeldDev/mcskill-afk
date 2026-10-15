// Authentication is refreshed only when needed, through the official launcher API.
export function passwordConnector({ credentials, initialSession, login, connect, signal, log }) {
  let session = initialSession, refreshPending = false;
  return async () => {
    try {
      if (!session) session = await login(credentials.username, credentials.password, credentials.authOrigin, signal);
      const result = await connect(session);
      if (result.ready) refreshPending = false;
      if (['AUTH_REJECTED','SERVER_SESSION_EXPIRED'].includes(result.error?.code) && !refreshPending) {
        session = undefined; refreshPending = true;
        log.event('session_refresh_scheduled');
        return { ...result, error:{ code:'SESSION_REFRESH', retryable:true } };
      }
      return result;
    } catch (error) {
      if (!error.code?.startsWith('LOGIN_')) throw error;
      // Downtime can last hours. Invalid credentials and extra verification remain terminal.
      return { error:{ code:error.code || 'INTERNAL', retryable:['LOGIN_NETWORK','LOGIN_TIMEOUT','LOGIN_SERVICE_ERROR'].includes(error.code) }, stableMs:0 };
    }
  };
}
