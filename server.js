const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const app = express();
const { exec, spawn } = require('child_process');
const cors = require('cors');
require('dotenv').config();

// Use dynamic port for Render
const port = process.env.PORT || 5000;

app.use(bodyParser.json());
app.use(cors());

app.use(bodyParser.json());

app.use(cors());

// Serve static files (questions)
app.use('/questions', express.static(path.join(__dirname, 'questions')));


// API endpoint to fetch a list of questions (example)
// API endpoint to fetch a list of questions
app.get('/api/questions', (req, res) => {
    const questionsDir = path.join(__dirname, 'questions');
    fs.readdir(questionsDir, (err, files) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to read questions directory' });
        }

        const questions = files
            .filter(file => file.endsWith('.json'))
            .map(file => {
                const filePath = path.join(questionsDir, file);
                const questionData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                return {
                    id: questionData.id,
                    title: questionData.title,
                    difficulty: questionData.difficulty,
                };
            });

        res.json(questions);
    });
});




const maxOutputLength = 500;  // Set the maximum output length to show (adjust as needed)
const TLE_LIMIT = 1000; // 1 second timeout in milliseconds

app.post('/validate-code', async (req, res) => {
    const { code, questionId } = req.body;

    if (!code || !questionId) {
        return res.status(400).json({ error: 'Code and Question ID are required' });
    }

    const testCasesPath = path.join(__dirname, 'test_cases', `Ques${questionId}`);
    if (!fs.existsSync(testCasesPath)) {
        return res.status(404).json({ error: 'Test cases not found for the question' });
    }

    const testFiles = fs.readdirSync(testCasesPath);
    const inputFiles = testFiles.filter(file => file.endsWith('.in'));

    let allPassed = true;
    let results = [];

    try {
        for (const inputFile of inputFiles) {
            const baseName = inputFile.replace('.in', '');
            const inputContent = fs.readFileSync(path.join(testCasesPath, inputFile), 'utf-8');
            const expectedOutput = fs.readFileSync(path.join(testCasesPath, `${baseName}.out`), 'utf-8').trim();

            const runResponse = await runCppWithPreciseTimeout(code, inputContent);

            if (runResponse.error) {
                results.push({
                    testCase: baseName,
                    passed: false,
                    error: runResponse.error,
                    details: runResponse.details,
                });
                allPassed = false;
                break;
            } else {
                const userOutput = runResponse.output.trim();
                const passed = userOutput === expectedOutput;

                results.push({
                    testCase: baseName,
                    passed,
                    expectedOutput: passed ? null : expectedOutput,
                    userOutput: passed ? null : userOutput,
                });

                if (!passed) allPassed = false;
            }
        }

        res.status(200).json({ allPassed, results });
    } catch (err) {
        res.status(500).json({ error: 'Unexpected error occurred', details: err.message });
    }
});



// Function to handle the timeout
const runCppWithPreciseTimeout = (code, input) => {
    return new Promise((resolve) => {
        const filePath = path.join(__dirname, `temp_${Date.now()}.cpp`);
        const outputPath = path.join(__dirname, `output_${Date.now()}`);
        
        const cleanup = () => {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        };

        // Add timing code to the user's program
        const instrumentedCode = `
#include <chrono>
#include <iostream>
#include <csignal>

auto start_time = std::chrono::high_resolution_clock::now();

void check_timeout(int) {
    auto current_time = std::chrono::high_resolution_clock::now();
    auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(
        current_time - start_time
    ).count();
    if (duration > ${EXECUTION_TIME_LIMIT}) {
        std::exit(124); // Special exit code for TLE
    }
}

${code}

int main() {
    signal(SIGALRM, check_timeout);
    ualarm(100000, 100000); // Check every 0.1 seconds
    auto real_start = std::chrono::high_resolution_clock::now();
    
    try {
        main_user();
    } catch (...) {
        std::cerr << "Runtime Error: Unknown exception caught" << std::endl;
        return 1;
    }
    
    auto end_time = std::chrono::high_resolution_clock::now();
    auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(
        end_time - real_start
    ).count();
    
    if (duration > ${EXECUTION_TIME_LIMIT}) {
        std::exit(124);
    }
    return 0;
}`;

        // Modify user's code to wrap their main function
        const modifiedCode = code.replace(
            /int\s+main\s*\([^)]*\)\s*{/g, 
            'int main_user() {'
        );

        fs.writeFile(filePath, instrumentedCode.replace('${code}', modifiedCode), async (err) => {
            if (err) {
                cleanup();
                return resolve({ error: 'Failed to write code to file' });
            }

            // Compile with optimizations and timing code
            exec(`g++ -O2 ${filePath} -o ${outputPath}`, (compileErr, stdout, stderr) => {
                if (compileErr) {
                    cleanup();
                    return resolve({ error: 'Compilation failed', details: stderr });
                }

                let processCompleted = false;
                const runProcess = spawn(outputPath);
                let output = '';
                let errorOutput = '';

                // Set a process timeout slightly longer than execution timeout
                const timeoutId = setTimeout(() => {
                    if (!processCompleted) {
                        runProcess.kill();
                        cleanup();
                        resolve({ error: 'TLE: Time Limit Exceeded' });
                    }
                }, EXECUTION_TIME_LIMIT + 500); // Add small buffer for process overhead

                runProcess.stdout.on('data', (data) => {
                    output += data.toString();
                });

                runProcess.stderr.on('data', (data) => {
                    errorOutput += data.toString();
                });

                if (input) {
                    runProcess.stdin.write(input);
                    runProcess.stdin.end();
                }

                runProcess.on('error', (error) => {
                    if (!processCompleted) {
                        processCompleted = true;
                        clearTimeout(timeoutId);
                        cleanup();
                        resolve({ error: 'Runtime error', details: error.message });
                    }
                });

                runProcess.on('close', (code) => {
                    if (!processCompleted) {
                        processCompleted = true;
                        clearTimeout(timeoutId);
                        cleanup();
                        
                        if (code === 124) {
                            resolve({ error: 'TLE: Time Limit Exceeded' });
                        } else if (code !== 0) {
                            resolve({ error: 'Runtime error', details: errorOutput });
                        } else {
                            resolve({ output });
                        }
                    }
                });
            });
        });
    });
};



// Utility function to compile and run C++ code
const runCpp = (code, input) => {
    return new Promise((resolve) => {
        const filePath = path.join(__dirname, 'temp.cpp');
        const outputPath = path.join(__dirname, 'output');

        fs.writeFile(filePath, code, (err) => {
            if (err) {
                return resolve({ error: 'Failed to write code to file' });
            }

            exec(`g++ ${filePath} -o ${outputPath}`, (compileErr, stdout, stderr) => {
                if (compileErr) {
                    fs.unlinkSync(filePath);
                    return resolve({ error: 'Compilation failed', details: stderr });
                }

                const runProcess = spawn(outputPath);
                let output = '';
                let errorOutput = '';

                runProcess.stdin.write(input);
                runProcess.stdin.end();

                runProcess.stdout.on('data', (data) => {
                    output += data.toString();
                });

                runProcess.stderr.on('data', (data) => {
                    errorOutput += data.toString();
                });

                runProcess.on('close', (code) => {
                    fs.unlinkSync(filePath);
                    fs.unlinkSync(outputPath);

                    if (code !== 0) {
                        return resolve({ error: 'Runtime error', details: errorOutput });
                    }

                    resolve({ output });
                });
            });
        });
    });
};
// API endpoint to fetch question details
app.get('/api/questions/:id', (req, res) => {
    const { id } = req.params;
    const questionFilePath = path.join(__dirname, 'questions', `${id}.json`);

    fs.readFile(questionFilePath, 'utf8', (err, data) => {
        if (err) {
            return res.status(404).json({ error: 'Question not found' });
        }
        res.json(JSON.parse(data));
    });
});
// Endpoint to log cheaters
// Other endpoints remain unchanged, but make sure temporary files and logs like `cheaters.txt` are handled correctly
app.post('/log-cheater', (req, res) => {
    const { name } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Name is required' });
    }

    // Append the name to cheaters.txt
    const cheaterEntry = `Cheater: ${name} - ${new Date().toISOString()}\n`;
    const cheatersFilePath = path.join(__dirname, 'cheaters.txt');  // Ensure file path for Render
    fs.appendFile(cheatersFilePath, cheaterEntry, (err) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to log cheater' });
        }
        res.status(200).json({ message: 'Cheater logged successfully' });
    });
});


app.post('/run-cpp', (req, res) => {
    const { code, input } = req.body;

    if (!code) {
        return res.status(400).json({ error: 'No C++ code provided' });
    }

    const filePath = path.join(__dirname, 'temp.cpp');
    const outputPath = path.join(__dirname, 'output');
    let responseSent = false;  // Flag to ensure response is only sent once

    fs.writeFile(filePath, code, (err) => {
        if (err) {
            if (!responseSent) {
                responseSent = true;
                return res.status(500).json({ error: 'Failed to write code to file' });
            }
        }

        exec(`g++ ${filePath} -o ${outputPath}`, (compileErr, stdout, stderr) => {
            if (compileErr) {
                if (!responseSent) {
                    responseSent = true;
                    return res.status(400).json({ error: 'Compilation failed', details: stderr });
                }
            }

            const runProcess = spawn(outputPath);
            let output = '';
            let errorOutput = '';

            // Send input to stdin
            runProcess.stdin.write(input);
            runProcess.stdin.end();

            // Collect data from stdout and stderr
            runProcess.stdout.on('data', (data) => {
                output += data.toString();
            });

            runProcess.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            // Timeout to detect TLE
            const timeoutTimer = setTimeout(() => {
                runProcess.kill();
                if (!responseSent) {
                    responseSent = true;
                    return res.status(500).json({ error: 'TLE: Time Limit Exceeded' });
                }
            }, 1000); // 1 second timeout

            runProcess.on('close', (code) => {
                clearTimeout(timeoutTimer);

                // Clean up files
                fs.unlinkSync(filePath);
                fs.unlinkSync(outputPath);

                // Truncate the output for displaying purposes
                const truncatedOutput = output.length > 200 ? output.slice(0, 200) + '...' : output;
                const truncatedErrorOutput = errorOutput.length > 200 ? errorOutput.slice(0, 200) + '...' : errorOutput;

                if (code !== 0) {
                    if (!responseSent) {
                        responseSent = true;
                        return res.status(500).json({ error: 'Runtime error', details: truncatedErrorOutput });
                    }
                }

                if (!responseSent) {
                    res.json({ output: truncatedOutput });
                    responseSent = true;
                }
            });
        });
    });
});


  

app.listen(port, () => {
    console.log(`C++ Compiler Backend listening at http://localhost:${port}`);
});