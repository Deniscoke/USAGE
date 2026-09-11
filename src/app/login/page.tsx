import { AuthForm } from "@/components/auth-form";
import { signIn } from "@/app/auth/actions";

interface LoginPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : undefined;
  // Set by /auth/callback when a confirmation link could not be used. Shown as
  // plain text, never as HTML, and it is the only thing this page reads from
  // the URL besides `next`.
  const notice = typeof params.notice === "string" ? params.notice.slice(0, 200) : undefined;

  return (
    <main className="flex-1">
      <AuthForm
        action={signIn}
        title="Sign in"
        submitLabel="Sign in"
        next={next}
        notice={notice}
        footer={{ prompt: "No account?", href: "/sign-up", linkLabel: "Create one" }}
      />
    </main>
  );
}
