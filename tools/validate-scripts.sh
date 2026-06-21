#!/bin/bash

# Parse --script <path> args (repeatable). Forwarded to Godot via the `--` user-args separator.
script_args=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --script)
            if [[ -z "${2:-}" ]]; then
                echo "ERROR: --script requires a path argument." >&2
                exit 2
            fi
            script_args+=("$2")
            shift 2
            ;;
        *)
            echo "ERROR: Unknown argument: $1" >&2
            echo "Usage: $0 [--script <path>]..." >&2
            exit 2
            ;;
    esac
done

# Build parallel array of `res://`-normalized filter paths so the parser below
# only emits errors/warnings whose source matches one of the requested files.
filter_res_paths=()
if [[ ${#script_args[@]} -gt 0 ]]; then
    project_root="$(pwd)/"
    for arg in "${script_args[@]}"; do
        if [[ "$arg" == res://* ]]; then
            filter_res_paths+=("$arg")
        elif [[ "$arg" == /* ]]; then
            filter_res_paths+=("res://${arg#"$project_root"}")
        else
            filter_res_paths+=("res://${arg}")
        fi
    done
fi

log_file=$(mktemp -t validate-scripts-godot-log.XXXXXX)
trap 'rm -f "$log_file"' EXIT

if [[ -n "${GODOT_EXECUTABLE:-}" ]]; then
    godot_executable="$GODOT_EXECUTABLE"
elif [[ -f "/Applications/Godot.app/Contents/MacOS/Godot" ]]; then
    godot_executable="/Applications/Godot.app/Contents/MacOS/Godot"
elif [[ -f "/c/godot.exe" ]]; then
    godot_executable="/c/godot.exe"
else
    echo "ERROR: Godot executable not found. Set GODOT_EXECUTABLE to its path." >&2
    exit 1
fi

if [[ ${#script_args[@]} -gt 0 ]]; then
    output=$("$godot_executable" -d --ignore-error-breaks --headless --log-file "$log_file" --path . --script tests/validate_all_scripts.gd -- "${script_args[@]}" 2>&1)
else
    output=$("$godot_executable" -d --ignore-error-breaks --headless --log-file "$log_file" --path . --script tests/validate_all_scripts.gd 2>&1)
fi
godot_exit_code=$?

error_found=0

_should_emit() {
    local actual_file="$1"
    if [[ ${#filter_res_paths[@]} -eq 0 ]]; then
        return 0
    fi
    if [[ -z "$actual_file" ]]; then
        return 1
    fi
    local fp
    for fp in "${filter_res_paths[@]}"; do
        if [[ "$actual_file" == "$fp" ]]; then
            return 0
        fi
    done
    return 1
}

current_validating_line=""
pending_error_line=""
pending_warning_line=""
warning_files=()
warning_lines=()
warning_texts=()
while IFS= read -r line; do
  if [[ "$line" =~ ^Validating[[:space:]] ]]; then
    current_validating_line="${line#Validating }"
  fi

  if [[ -n "$pending_error_line" && "$line" =~ ^[[:space:]]*at:[[:space:]] ]]; then
    paren_regex='\(([^)]+)\)'
    if [[ "$line" =~ $paren_regex ]]; then
      actual_source="${BASH_REMATCH[1]}"
      actual_file="${actual_source%:*}"
      actual_line="${actual_source##*:}"

      if [[ "$pending_error_line" == *"Failed to compile depended scripts"* ]]; then
        pending_error_line=""
        continue
      fi

      if ! _should_emit "$actual_file"; then
        pending_error_line=""
        continue
      fi

      echo ""
      if [[ -n "$current_validating_line" ]]; then
        echo -e "\033[90mWhile validating: ${current_validating_line}\033[0m"
      fi
      if [[ -n "$actual_line" && "$actual_line" != "0" ]]; then
        echo -e "\033[36;1mError in ${actual_file}\033[0m on line \033[97;1m${actual_line}\033[0m"
      else
        echo -e "\033[36;1mError in ${actual_file}\033[0m"
      fi

      if [[ "$pending_error_line" == *"Could not parse global class"* ||\
           "$pending_error_line" == *"Failed to compile depended scripts"* ||\
           "$pending_error_line" == *"Could not resolve class"* \
          ]]; then
        echo -e "  \033[90m${pending_error_line}\033[0m"
      else
        echo -e "  \033[91;1m${pending_error_line}\033[0m"
      fi
      echo -e "  \033[90m${line}\033[0m"
    fi
    pending_error_line=""
    continue
  fi

  if [[ -n "$pending_error_line" && ! "$line" =~ ^[[:space:]]*at:[[:space:]] ]]; then
    if [[ ${#filter_res_paths[@]} -gt 0 ]]; then
      pending_error_line=""
    else
      echo ""
      if [[ -n "$current_validating_line" ]]; then
        echo -e "\033[36;1m${current_validating_line}\033[0m"
      fi
      if [[ "$pending_error_line" == *"Could not parse global class"* ||\
           "$pending_error_line" == *"Failed to compile depended scripts"* ||\
           "$pending_error_line" == *"Could not resolve class"* \
          ]]; then
        echo -e "  \033[90m${pending_error_line}\033[0m"
      else
        echo -e "  \033[97;1m${pending_error_line}\033[0m"
      fi
      pending_error_line=""
    fi
  fi

  if [[ -n "$pending_warning_line" && "$line" =~ ^[[:space:]]*at:[[:space:]] ]]; then
    paren_regex='\(([^)]+)\)'
    if [[ "$line" =~ $paren_regex ]]; then
      actual_source="${BASH_REMATCH[1]}"
      actual_file="${actual_source%:*}"
      actual_line="${actual_source##*:}"
      if _should_emit "$actual_file"; then
        warning_files+=("${actual_file}")
        warning_lines+=("${actual_line}")
        warning_texts+=("${pending_warning_line}")
      fi
    else
      if [[ ${#filter_res_paths[@]} -eq 0 ]]; then
        warning_files+=("")
        warning_lines+=("")
        warning_texts+=("${pending_warning_line}")
      fi
    fi
    pending_warning_line=""
    continue
  fi

  if [[ -n "$pending_warning_line" && ! "$line" =~ ^[[:space:]]*at:[[:space:]] ]]; then
    if [[ ${#filter_res_paths[@]} -eq 0 ]]; then
      warning_files+=("")
      warning_lines+=("")
      warning_texts+=("${pending_warning_line}")
    fi
    pending_warning_line=""
  fi

  if [[ "$line" == *"SCRIPT ERROR"* ]]; then
    pending_error_line="$line"
    error_found=1
  elif [[ "$line" == *"WARNING:"* ]]; then
    pending_warning_line="$line"
  fi
done <<< "$output"

if [[ -n "$pending_error_line" && ${#filter_res_paths[@]} -eq 0 ]]; then
  echo ""
  if [[ -n "$current_validating_line" ]]; then
    echo -e "\033[36;1m${current_validating_line}\033[0m"
  fi
  echo -e "  \033[97;1m${pending_error_line}\033[0m"
fi

if [[ -n "$pending_warning_line" && ${#filter_res_paths[@]} -eq 0 ]]; then
  warning_files+=("")
  warning_lines+=("")
  warning_texts+=("${pending_warning_line}")
fi

if [[ ${#warning_texts[@]} -gt 0 ]]; then
  echo ""
  echo -e "\033[33;1mWarnings (${#warning_texts[@]}):\033[0m"
  sorted_indices=()
  while IFS= read -r idx; do
    sorted_indices+=("$idx")
  done < <(
    for i in "${!warning_files[@]}"; do
      echo "${warning_files[$i]}	$i"
    done | sort -t'	' -k1,1 | cut -f2
  )
  last_file=""
  for i in "${sorted_indices[@]}"; do
    file="${warning_files[$i]}"
    line="${warning_lines[$i]}"
    text="${warning_texts[$i]}"
    if [[ "$file" != "$last_file" ]]; then
      if [[ -n "$file" ]]; then
        echo -e "  \033[36;1m${file}\033[0m"
      else
        echo -e "  \033[36;1m(unknown source)\033[0m"
      fi
      last_file="$file"
    fi
    if [[ -n "$line" ]]; then
      echo -e "    \033[33mLine ${line}: ${text}\033[0m"
    else
      echo -e "    \033[33m${text}\033[0m"
    fi
  done
fi

if [[ $godot_exit_code -ne 0 && $error_found -eq 0 ]]; then
  echo "" >&2
  echo -e "\033[91;1mGodot exited with code ${godot_exit_code}.\033[0m" >&2
  echo -e "\033[91;1mScripts were not validated.\033[0m" >&2
  echo "" >&2
  echo -e "\033[90mGodot output:\033[0m" >&2
  echo "$output" >&2
  exit 1
elif [[ $error_found -eq 1 ]]; then
  echo ""
  echo -e "\033[91;1mOne or more scripts failed validation.\033[0m Sometimes one error leads to others, so the most likely cause of the errors"
  echo -e "are highlighted in \033[97;1mwhite\033[0m. Errors in \033[90mgray\033[0m are usually cascade errors from the primary failure.\033[0m"
  exit 1
else
  echo ""
  if [[ ${#warning_texts[@]} -gt 0 ]]; then
    echo -e "\033[32;1mAll scripts validated successfully\033[0m (with ${#warning_texts[@]} warning(s))."
  else
    echo -e "\033[32;1mAll scripts validated successfully.\033[0m"
  fi
  exit 0
fi
