import { useState } from "react";
import type { Candidate, ToolId } from "../../engine/types.js";
import { Welcome } from "./screens/Welcome.js";
import { Tools } from "./screens/Tools.js";
import { Projects } from "./screens/Projects.js";
import { Done } from "./screens/Done.js";

type Step = "welcome" | "tools" | "projects" | "done";

export function App() {
  const [step, setStep] = useState<Step>("welcome");
  const [tools, setTools] = useState<ToolId[]>([]);
  const [chosen, setChosen] = useState<Candidate[]>([]);

  return (
    <div className="app">
      <div className="drag-strip" />
      {step === "welcome" && <Welcome onNext={() => setStep("tools")} />}
      {step === "tools" && (
        <Tools
          onBack={() => setStep("welcome")}
          onNext={(selected) => {
            setTools(selected);
            setStep("projects");
          }}
        />
      )}
      {step === "projects" && (
        <Projects
          tools={tools}
          onBack={() => setStep("tools")}
          onNext={(selected) => {
            setChosen(selected);
            setStep("done");
          }}
        />
      )}
      {step === "done" && <Done chosen={chosen} onRestart={() => setStep("welcome")} />}
    </div>
  );
}
