interface Props {
  onAdd: () => void;
  error: string | null;
  cliVersion: string | null;
}

/** First run, and whenever no project is open. */
export function Welcome({ onAdd, error, cliVersion }: Props) {
  return (
    <div className="blank">
      <div className="blank__inner">
        <h1>Read a project in order</h1>
        <p>
          Point Speck at a folder that contains an <code>openspec</code>{" "}
          directory. It groups the project by where each document sits in the
          workflow, and numbers them so you can read start to finish.
        </p>
        <button className="button" onClick={onAdd}>
          Open a project folder
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p className="blank__hint">
          {cliVersion
            ? `Using the openspec CLI, version ${cliVersion}.`
            : "The openspec CLI was not found, so Speck will read projects with its own scanner."}
        </p>
      </div>
    </div>
  );
}
