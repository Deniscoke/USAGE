import { AuthForm } from "@/components/auth-form";
import { signIn } from "@/app/auth/actions";

interface LoginPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : undefined;

  return (
    <main className="flex-1">
      <AuthForm
        action={signIn}
        title="Sign in"
        submitLabel="Sign in"
        next={next}
        footer={{ prompt: "No account?", href: "/sign-up", linkLabel: "Create one" }}
      />
    </main>
  );
}
