import { AuthForm } from "@/components/auth-form";
import { signUp } from "@/app/auth/actions";

export default function SignUpPage() {
  return (
    <main className="flex-1">
      <AuthForm
        action={signUp}
        title="Create account"
        submitLabel="Create account"
        footer={{ prompt: "Already have an account?", href: "/login", linkLabel: "Sign in" }}
      />
    </main>
  );
}
