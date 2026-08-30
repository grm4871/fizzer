export async function installBrowserSession(context, apiBase, token) {
  await context.addCookies([{
    name: 'cascade_session',
    value: token,
    url: apiBase,
    httpOnly: true,
    secure: new URL(apiBase).protocol === 'https:',
    sameSite: 'Lax',
  }]);
}
