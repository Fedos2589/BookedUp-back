// The signed-in user as @nestjs/authentication hands it around (@CurrentUser(),
// AuthenticationContext): the account, never its password.
export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

declare module '@nestjs/authentication' {
  interface AuthenticationTypes {
    user: AuthUser;
    // What PrismaSessionStore.getSession() joins to the session.
    sessionExtra: AuthUser;
  }
}
