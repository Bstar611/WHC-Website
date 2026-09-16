// ============================================================
// 1. SUPABASE CONFIGURATION
// ============================================================
const SUPABASE_URL = 'https://tfradfxljdfcjenpuoxt.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_z4Wy19-QK_0YKtsJtEhkHA_US4PL8TM';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// A standalone logout function, callable directly from an inline onclick=""
// attribute in the HTML — this works even if something else earlier in the
// page's startup script fails, since it doesn't depend on the same
// addEventListener setup running successfully first.
async function handleLogout() {
    await supabaseClient.auth.signOut();
    window.location.href = 'index.html';
}

// ============================================================
// 2. UTILITY FUNCTIONS
// ============================================================
function showMessage(elId, msg, isError = false) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? '#b91c1c' : '#166534';
}

// ============================================================
// Shared CA (Continuous Assessment) calculation, used EVERYWHERE
// a subject's CA is computed — report cards, cumulative scores,
// best graduating students, etc — so it can never drift out of
// sync between screens again.
//
// CA = (average weekly score out of 100) scaled down to a 25-point
// max, i.e. (sum of scores / number of weeks tested) * 0.25.
// This matters specifically EARLY in a term: a flat "sum capped at
// 25" approach means almost any real score after just 1-2 weeks
// immediately hits the 25 ceiling, making everyone look identical
// regardless of their actual performance. Normalizing by how many
// weeks have actually been tested avoids that entirely.
// ============================================================
function calculateCA(scores) {
    if (!scores || scores.length === 0) return 0;
    const sum = scores.reduce((s, v) => s + v, 0);
    const average = sum / scores.length; // out of 100
    return Math.round(average * 0.25); // scaled to a 25-point max, rounded
}

function getGrade(score) {
    if (score >= 80) return 'A';
    if (score >= 70) return 'B';
    if (score >= 60) return 'C';
    if (score >= 50) return 'D';
    if (score >= 40) return 'E';
    return 'F';
}

function getGradeColor(grade) {
    if (grade === 'A' || grade === 'B') return '#000000';
    if (grade === 'C' || grade === 'D') return '#1a3c5e';
    return '#b91c1c'; // E, F
}

function getOrdinal(n) {
    if (!n || n < 1) return '-';
    const suffixes = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}

function getCharacterColor(rating) {
    if (rating === 'Excellent') return '#000000';
    if (rating === 'Good' || rating === 'Credit') return '#1a3c5e';
    if (rating === 'Fair' || rating === 'Poor') return '#b91c1c';
    return '#666666';
}

function getPositionColor(position) {
    if (position === 1) return '#d4a373';
    if (position === 2) return '#c0c0c0';
    if (position === 3) return '#cd7f32';
    if (position <= 5) return '#1a3c5e';
    return '#333333';
}

// ============================================================
// Computes a student's Performance %, Position in Class, and
// Position in Group, by comparing them against every classmate
// currently in the same class for the same term. JSS positions
// halve-and-round into groups; SSS positions rank within the
// student's department instead of the whole class.
// Also returns each subject's individual class position.
// ============================================================
async function computeReportCardPositions(studentId, classId, termId) {
    const { data: classmates } = await supabaseClient
        .from('students')
        .select('id, department_id, classes(section)')
        .eq('class_id', classId);

    if (!classmates || classmates.length === 0) return null;

    const classmateIds = classmates.map(s => s.id);
    const section = classmates[0]?.classes?.section;

    const { data: allWeekly } = await supabaseClient
        .from('weekly_test_results')
        .select('student_id, subject_id, score')
        .eq('term_id', termId)
        .in('student_id', classmateIds);

    const { data: allExams } = await supabaseClient
        .from('exam_scores')
        .select('student_id, subject_id, exam_score')
        .eq('term_id', termId)
        .in('student_id', classmateIds);

    const subjectIds = [...new Set([...(allWeekly || []).map(w => w.subject_id), ...(allExams || []).map(e => e.subject_id)])];

    // Per-subject totals for every classmate, for subject-level positions
    const subjectPositions = {};
    subjectIds.forEach(subId => {
        const subjectTotals = classmates.map(s => {
            const weekly = (allWeekly || []).filter(w => w.student_id === s.id && w.subject_id === subId);
            const ca = calculateCA(weekly.map(w => w.score));
            const examEntry = (allExams || []).find(e => e.student_id === s.id && e.subject_id === subId);
            const exam = Math.min(75, examEntry?.exam_score || 0);
            return { studentId: s.id, total: ca + exam, hasData: weekly.length > 0 || !!examEntry };
        }).filter(s => s.hasData);
        subjectTotals.sort((a, b) => b.total - a.total);
        subjectPositions[subId] = {};
        subjectTotals.forEach((s, i) => { subjectPositions[subId][s.studentId] = i + 1; });
    });

    // Overall performance per classmate
    const performances = classmates.map(s => {
        let totalSum = 0, count = 0;
        subjectIds.forEach(subId => {
            const weekly = (allWeekly || []).filter(w => w.student_id === s.id && w.subject_id === subId);
            const examEntry = (allExams || []).find(e => e.student_id === s.id && e.subject_id === subId);
            if (weekly.length === 0 && !examEntry) return;
            const ca = calculateCA(weekly.map(w => w.score));
            const exam = Math.min(75, examEntry?.exam_score || 0);
            totalSum += ca + exam;
            count++;
        });
        return {
            studentId: s.id,
            performance: count > 0 ? totalSum / count : 0,
            departmentId: s.department_id
        };
    });

    performances.sort((a, b) => b.performance - a.performance);

    const target = performances.find(p => p.studentId === studentId);
    if (!target) return null;

    const positionInClass = performances.findIndex(p => p.studentId === studentId) + 1;
    const isPass = target.performance >= 40;
    const isJSS = section === 'Junior';

    let positionInGroup = null;
    if (isPass) {
        if (isJSS) {
            positionInGroup = Math.round(positionInClass / 2);
        } else {
            const deptPeers = performances.filter(p => p.departmentId === target.departmentId);
            positionInGroup = deptPeers.findIndex(p => p.studentId === studentId) + 1;
        }
    }

    const mySubjectPositions = {};
    subjectIds.forEach(subId => {
        mySubjectPositions[subId] = subjectPositions[subId][studentId] || null;
    });

    return {
        performance: target.performance,
        positionInClass: isPass ? positionInClass : null,
        positionInGroup,
        totalInClass: performances.length,
        isPass,
        subjectPositions: mySubjectPositions,
        isJSS
    };
}

// ============================================================
// SHARED REPORT CARD RENDERER
// Used by: student's own dashboard, parent's view of each child,
// and admin's bulk report card download — so all three always
// show identical, correctly-calculated results.
// ============================================================
function renderReportCardHTML(studentData, weeklyData, examData, characterData, termName, positionData, termInfo, signatureUrl) {
    const charFields = [
        { key: 'honesty', label: 'Honesty' },
        { key: 'hardwork', label: 'Hardwork' },
        { key: 'intelligence', label: 'Intelligence' },
        { key: 'neatness', label: 'Neatness' },
        { key: 'use_of_initiative', label: 'Use of Initiative' }
    ];

    if (!weeklyData || weeklyData.length === 0) {
        return `
            <div class="glass-card" style="text-align:center;">
                <h3>No Results Yet</h3>
                <p><strong>${studentData.full_name}</strong>'s report card will appear here once teachers upload scores.</p>
            </div>
        `;
    }

    const subjectMap = {};
    weeklyData.forEach(w => {
        if (!subjectMap[w.subject_id]) {
            subjectMap[w.subject_id] = { name: w.subjects?.name || 'Unknown', weeks: [] };
        }
        subjectMap[w.subject_id].weeks.push({ week: w.week_number, score: w.score });
    });

    let totalSum = 0;
    let count = 0;
    let subjectRows = '';

    for (const subjectId in subjectMap) {
        const sub = subjectMap[subjectId];
        const cappedCA = calculateCA(sub.weeks.map(w => w.score));
        const examEntry = examData?.find(e => e.subject_id == subjectId);
        const examScore = examEntry?.exam_score || 0;
        const cappedExam = Math.min(75, examScore);
        const finalTotal = cappedCA + cappedExam;
        totalSum += finalTotal;
        count++;

        const grade = getGrade(finalTotal);
        const gradeColor = getGradeColor(grade);
        const subjectPosition = positionData?.subjectPositions?.[subjectId];

        subjectRows += `
            <tr style="border-bottom:1px solid #ddd;">
                <td style="padding:8px;"><strong>${sub.name}</strong></td>
                <td style="padding:8px; color:#1a3c5e;">${cappedCA}</td>
                <td style="padding:8px; color:#1a3c5e;">${cappedExam}</td>
                <td style="padding:8px; font-weight:bold; color:#000000;">${finalTotal}</td>
                <td style="padding:8px; color:${gradeColor}; font-weight:bold;">${grade}</td>
                <td style="padding:8px;">${subjectPosition ? getOrdinal(subjectPosition) : '-'}</td>
            </tr>
        `;
    }

    const average = count > 0 ? (totalSum / count) : 0;
    const overallGrade = getGrade(average);
    const overallGradeColor = getGradeColor(overallGrade);
    const isPass = positionData ? positionData.isPass : average >= 40;

    let characterRows = '';
    if (characterData) {
        for (const field of charFields) {
            const value = characterData[field.key] || 'Not assessed';
            const color = getCharacterColor(value);
            characterRows += `
                <tr style="border-bottom:1px solid #ddd;">
                    <td style="padding:8px;">${field.label}</td>
                    <td style="padding:8px; color:${color}; font-weight:bold;">${value}</td>
                </tr>
            `;
        }
    } else {
        characterRows = `
            <tr>
                <td colspan="2" style="padding:8px; text-align:center; color:#666;">
                    Character assessment not yet completed.
                </td>
            </tr>
        `;
    }

    const remark = characterData?.class_teacher_remark;
    const nextTermBegins = termInfo?.next_term_begins;
    const logoSrc = 'images/wonderhills-logo.png';
    const qrData = encodeURIComponent(`Wonderhills College | ${studentData.full_name} | ${studentData.admission_number} | ${termName}`);
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=90x90&data=${qrData}`;

    return `
        <div class="glass-card" style="max-width: 1000px; margin: 0 auto;">
            <div style="display:flex; align-items:center; justify-content:center; gap:1rem; text-align:center;">
                <img src="${logoSrc}" alt="Wonderhills College" style="height:70px;">
                <div>
                    <h2 style="color:#4a2c1a; margin:0;">Wonderhills College</h2>
                    <p style="margin:0; font-style:italic; color:#6b3a2a;">Terminal Report Sheet</p>
                </div>
            </div>
            <hr style="border: 1px solid #d4a373; margin: 1rem 0;">
            <div style="display:flex; justify-content:space-between; flex-wrap:wrap;">
                <p><strong>Student:</strong> ${studentData.full_name}</p>
                <p><strong>Admission:</strong> ${studentData.admission_number}</p>
                <p><strong>Class:</strong> ${studentData.classes?.name || studentData.class_name || 'N/A'}</p>
                <p><strong>Term:</strong> ${termName}</p>
            </div>
            <hr style="border: 1px solid #d4a373; margin: 1rem 0;">

            <h4 style="color:#4a2c1a;">Academic Performance</h4>
            <div style="overflow-x:auto;">
                <table style="width:100%; border-collapse:collapse; text-align:left;">
                    <thead>
                        <tr style="background:#4a2c1a; color:white;">
                            <th style="padding:8px;">Subject</th>
                            <th style="padding:8px;">CA (25)</th>
                            <th style="padding:8px;">Exam</th>
                            <th style="padding:8px;">Total (100)</th>
                            <th style="padding:8px;">Grade</th>
                            <th style="padding:8px;">Position</th>
                        </tr>
                    </thead>
                    <tbody>${subjectRows}</tbody>
                </table>
            </div>
            <hr style="border: 1px solid #d4a373; margin: 1rem 0;">

            <h4 style="color:#4a2c1a;">Character Assessment</h4>
            <p style="font-size:0.8rem; color:#666;">
                <span style="color:#000000; font-weight:bold;">Excellent</span> ·
                <span style="color:#1a3c5e; font-weight:bold;">Good / Credit</span> ·
                <span style="color:#b91c1c; font-weight:bold;">Fair / Poor</span>
            </p>
            <div style="overflow-x:auto;">
                <table style="width:100%; border-collapse:collapse; text-align:left;">
                    <thead>
                        <tr style="background:#4a2c1a; color:white;">
                            <th style="padding:8px;">Criteria</th>
                            <th style="padding:8px;">Rating</th>
                        </tr>
                    </thead>
                    <tbody>${characterRows}</tbody>
                </table>
            </div>
            <hr style="border: 1px solid #d4a373; margin: 1rem 0;">

            <div style="text-align:center;">
                <h4 style="color:#4a2c1a;">Overall Performance</h4>
                <p><strong>Performance in Percentage:</strong> ${average.toFixed(1)}%</p>
                <p><strong>Overall Grade:</strong> <span style="color:${overallGradeColor}; font-weight:bold;">${overallGrade}</span></p>
                <p><strong>Result:</strong> <span style="color:${isPass ? '#166534' : '#b91c1c'}; font-weight:bold;">${isPass ? 'Pass' : 'Weak Pass'}</span></p>
                <p><strong>Position in Class:</strong> ${isPass && positionData?.positionInClass ? `${getOrdinal(positionData.positionInClass)} of ${positionData.totalInClass}` : 'Weak Pass'}</p>
                <p><strong>Position in Group:</strong> ${isPass && positionData?.positionInGroup ? getOrdinal(positionData.positionInGroup) : 'Weak Pass'}</p>
            </div>
            <hr style="border: 1px solid #d4a373; margin: 1rem 0;">

            <div>
                <h4 style="color:#4a2c1a;">Class Teacher's Remark</h4>
                <p style="min-height:1.5rem; font-style:italic;">${remark || 'No remark given yet.'}</p>
            </div>

            ${nextTermBegins ? `<p style="margin-top:1rem;"><strong>Next Term Begins:</strong> ${nextTermBegins}</p>` : ''}

            <hr style="border: 1px solid #d4a373; margin: 1.5rem 0;">
            <div style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:1rem;">
                <div>
                    ${signatureUrl ? `<img src="${signatureUrl}" style="height:50px; display:block; margin-bottom:0.2rem;">` : '<div style="height:50px;"></div>'}
                    <p style="border-top:1px solid #333; padding-top:0.3rem; margin-top:0.2rem; width:220px;">Principal's Signature & Date: ${new Date().toLocaleDateString()}</p>
                </div>
                <div style="text-align:center;">
                    <img src="${qrUrl}" alt="Verification QR Code" style="width:90px; height:90px;">
                    <p style="font-size:0.7rem; color:#666; margin-top:0.3rem;">Scan to verify</p>
                </div>
            </div>
        </div>
    `;
}

// ============================================================
// 3. AI ANALYTICS FUNCTIONS
// ============================================================

async function calculateRiskScore(studentId) {
    // Look up the active term's actual length, since terms don't all run the same number of weeks
    const { data: activeTermData } = await supabaseClient
        .from('terms')
        .select('id, weeks_count')
        .eq('is_active', true)
        .limit(1);
    const termWeeksCount = activeTermData?.[0]?.weeks_count || 8;

    // 1. Academic Performance (40%)
    const { data: weeklyScores } = await supabaseClient
        .from('weekly_test_results')
        .select('score')
        .eq('student_id', studentId);

    let academicScore = 0;
    if (weeklyScores && weeklyScores.length > 0) {
        const avgScore = weeklyScores.reduce((sum, s) => sum + s.score, 0) / weeklyScores.length;
        academicScore = Math.min(1, avgScore / 100);
    }

    // 2. Attendance (25%)
    const { data: attendance } = await supabaseClient
        .from('attendance')
        .select('status')
        .eq('student_id', studentId);

    let attendanceScore = 0;
    if (attendance && attendance.length > 0) {
        const presentCount = attendance.filter(a => a.status === 'Present').length;
        attendanceScore = presentCount / attendance.length;
        const latePenalty = attendance.filter(a => a.status === 'Late').length * 0.02;
        attendanceScore = Math.max(0, attendanceScore - latePenalty);
    }

    // 3. Assignments (15%) - real assignment completion rate, now that
    // actual assignment data exists (previously used weekly-test submission
    // count as a rough stand-in, since there was nothing else to go on)
    const { data: submissions } = await supabaseClient
        .from('assignment_submissions')
        .select('completed')
        .eq('student_id', studentId);

    let assignmentScore = 0.5;
    if (submissions && submissions.length > 0) {
        const completedCount = submissions.filter(s => s.completed).length;
        assignmentScore = completedCount / submissions.length;
    }

    // 4. Character (20%) - averages Honesty, Hardwork, Intelligence, Neatness,
    // Use of Initiative. This factor absorbed what used to be a separate
    // "Participation" score, since that criterion no longer exists on its own.
    const { data: character } = await supabaseClient
        .from('character_assessment')
        .select('honesty, hardwork, intelligence, neatness, use_of_initiative')
        .eq('student_id', studentId)
        .order('created_at', { ascending: false })
        .limit(1);

    let characterScore = 0.5;
    if (character && character.length > 0) {
        const charMap = { 'Excellent': 1.0, 'Good': 0.85, 'Credit': 0.7, 'Fair': 0.5, 'Poor': 0.25 };
        const charValues = Object.values(character[0]).filter(v => v !== null && v !== undefined);
        const total = charValues.reduce((sum, val) => sum + (charMap[val] || 0.5), 0);
        characterScore = charValues.length > 0 ? total / charValues.length : 0.5;
    }

    const totalScore = (
        academicScore * 0.4 +
        attendanceScore * 0.25 +
        assignmentScore * 0.15 +
        characterScore * 0.20
    ) * 100;

    let riskLevel, riskColor, message;
    if (totalScore >= 75) {
        riskLevel = 'Low Risk';
        riskColor = '#166534';
        message = '✅ Student is on track for success.';
    } else if (totalScore >= 50) {
        riskLevel = 'Moderate Risk';
        riskColor = '#d79b00';
        message = '⚠️ Student needs some attention. Monitor closely.';
    } else if (totalScore >= 30) {
        riskLevel = 'High Risk';
        riskColor = '#b91c1c';
        message = '🚨 Student is at serious risk of failing. Immediate intervention needed.';
    } else {
        riskLevel = 'Critical Risk';
        riskColor = '#7f1d1d';
        message = '🚨🚨 URGENT: Student requires immediate intervention.';
    }

    return {
        score: Math.round(totalScore),
        riskLevel: riskLevel,
        riskColor: riskColor,
        message: message,
        details: {
            academic: Math.round(academicScore * 100),
            attendance: Math.round(attendanceScore * 100),
            assignments: Math.round(assignmentScore * 100),
            character: Math.round(characterScore * 100)
        }
    };
}

function getWarnings(riskData) {
    const warnings = [];
    const d = riskData.details;

    if (d.academic < 50) {
        warnings.push({ icon: '🔴', message: 'Academic performance is below average.', color: '#b91c1c' });
    }
    if (d.attendance < 60) {
        warnings.push({ icon: '🔴', message: 'Attendance is concerning. Student misses school frequently.', color: '#b91c1c' });
    }
    if (d.attendance < 80 && d.attendance >= 60) {
        warnings.push({ icon: '🟡', message: 'Attendance dropped recently. Monitor closely.', color: '#d79b00' });
    }
    if (d.assignments < 60) {
        warnings.push({ icon: '🔴', message: 'Assignment completion rate is low.', color: '#b91c1c' });
    }
    if (d.character < 50) {
        warnings.push({ icon: '🟡', message: 'Character assessment indicates behavioral concerns.', color: '#d79b00' });
    }

    return warnings;
}

function getRecommendations(riskData) {
    const recommendations = [];
    const d = riskData.details;

    if (d.academic < 50) {
        recommendations.push('📚 Schedule extra tutoring sessions for weak subjects.');
        recommendations.push('📝 Provide additional practice materials.');
    }
    if (d.attendance < 70) {
        recommendations.push('🏫 Contact parents immediately regarding attendance.');
        recommendations.push('📊 Track attendance daily and intervene early.');
    }
    if (d.assignments < 60) {
        recommendations.push('📋 Set up a structured homework schedule.');
        recommendations.push('📌 Monitor assignment submission weekly.');
    }
    if (d.character < 50) {
        recommendations.push('💬 Encourage positive behavior through group activities.');
        recommendations.push('🎯 Set character-building goals with rewards.');
    }
    if (d.character < 60) {
        recommendations.push('🤝 Schedule a meeting with the student to discuss behavior.');
        recommendations.push('🏆 Implement a positive reinforcement system.');
    }
    if (riskData.score < 50) {
        recommendations.push('🚨 URGENT: Coordinate with parents and school counselor.');
        recommendations.push('📋 Develop an individualized intervention plan.');
    }
    if (recommendations.length === 0) {
        recommendations.push('✅ Student is performing well. Continue current strategies.');
        recommendations.push('📈 Encourage student to maintain high standards.');
    }

    return recommendations.slice(0, 6);
}

function renderFactorBar(label, value, color) {
    const pct = Math.min(100, value || 0);
    const barColor = pct >= 75 ? '#166534' : pct >= 50 ? '#d79b00' : '#b91c1c';
    return `
        <div style="margin:0.3rem 0;">
            <div style="display:flex; justify-content:space-between; font-size:0.9rem;">
                <span>${label}</span>
                <span style="font-weight:bold; color:${barColor};">${pct}%</span>
            </div>
            <div style="width:100%; background:#e0e0e0; border-radius:6px; height:8px; overflow:hidden;">
                <div style="width:${pct}%; background:${barColor}; height:100%; border-radius:6px;"></div>
            </div>
        </div>
    `;
}

async function loadStudentAIAnalytics() {
    const container = document.getElementById('aiAnalyticsContainer');
    if (!container) return;

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
        container.innerHTML = '<p>Please log in to view analytics.</p>';
        return;
    }

    const { data: student } = await supabaseClient
        .from('students')
        .select('id, full_name, classes(name)')
        .eq('user_id', user.id)
        .maybeSingle();

    if (!student) {
        container.innerHTML = '<p>Student record not found.</p>';
        return;
    }

    const riskData = await calculateRiskScore(student.id);
    const warnings = getWarnings(riskData);
    const recommendations = getRecommendations(riskData);

    let html = `
        <div class="glass-card">
            <h3>🤖 AI Risk Prediction</h3>
            <p>Analyzing academic performance, attendance, and engagement.</p>
            <hr style="border: 1px solid #d4a373; margin: 1rem 0;">

            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap;">
                <div>
                    <span style="font-size:2rem; font-weight:bold; color:${riskData.riskColor};">${riskData.score}%</span>
                    <span style="font-size:1.1rem; font-weight:bold; color:${riskData.riskColor};">${riskData.riskLevel}</span>
                </div>
                <div>
                    <span style="color:${riskData.riskColor};">${riskData.message}</span>
                </div>
            </div>

            <div style="width:100%; background:#e0e0e0; border-radius:10px; height:20px; margin-top:0.5rem; overflow:hidden;">
                <div style="width:${riskData.score}%; background:${riskData.riskColor}; height:100%; border-radius:10px;"></div>
            </div>

            <hr style="border: 1px solid #d4a373; margin: 1rem 0;">

            <h4>📊 Factor Breakdown</h4>
            ${renderFactorBar('Academic Performance (40%)', riskData.details.academic, '#1a3c5e')}
            ${renderFactorBar('Attendance (25%)', riskData.details.attendance, '#4a90d9')}
            ${renderFactorBar('Assignments (15%)', riskData.details.assignments, '#d4a373')}
            ${renderFactorBar('Character (20%)', riskData.details.character, '#2d1a0e')}

            <hr style="border: 1px solid #d4a373; margin: 1rem 0;">

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:1.5rem;">
                <div>
                    <h4>⚠️ Warning Signs</h4>
                    ${warnings.length > 0 ? warnings.map(w =>
                        `<div style="padding:0.3rem 0; color:${w.color};">${w.icon} ${w.message}</div>`
                    ).join('') : '<div style="color:#166534;">✅ No warnings identified.</div>'}
                </div>
                <div>
                    <h4>💡 Recommendations</h4>
                    ${recommendations.map(r =>
                        `<div style="padding:0.3rem 0;">${r}</div>`
                    ).join('')}
                </div>
            </div>

            <p style="font-size:0.8rem; color:#6b3a2a; margin-top:1rem;">
                * Risk score is based on academic performance, attendance, assignments, and character assessment.
            </p>
        </div>
    `;

    container.innerHTML = html;
}

// ============================================================
// 4. PARENT AI ANALYTICS FUNCTIONS
// ============================================================

async function loadParentChildAIAnalytics(studentId) {
    const container = document.getElementById('childAIAnalyticsContainer');
    if (!container) return;

    const { data: student } = await supabaseClient
        .from('students')
        .select('full_name, classes(name)')
        .eq('id', studentId)
        .single();

    if (!student) {
        container.innerHTML = '<p>Student not found.</p>';
        return;
    }

    const riskData = await calculateRiskScore(studentId);
    const warnings = getWarnings(riskData);
    const recommendations = getRecommendations(riskData);

    let html = `
        <div class="glass-card" style="margin-top:1rem;">
            <h3>🤖 AI Risk Prediction for ${student.full_name}</h3>
            <hr style="border: 1px solid #d4a373; margin: 1rem 0;">

            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap;">
                <div>
                    <span style="font-size:2rem; font-weight:bold; color:${riskData.riskColor};">${riskData.score}%</span>
                    <span style="font-size:1.1rem; font-weight:bold; color:${riskData.riskColor};">${riskData.riskLevel}</span>
                </div>
                <div>
                    <span style="color:${riskData.riskColor};">${riskData.message}</span>
                </div>
            </div>

            <div style="width:100%; background:#e0e0e0; border-radius:10px; height:20px; margin-top:0.5rem; overflow:hidden;">
                <div style="width:${riskData.score}%; background:${riskData.riskColor}; height:100%; border-radius:10px;"></div>
            </div>

            <hr style="border: 1px solid #d4a373; margin: 1rem 0;">

            <h4>📊 Factor Breakdown</h4>
            ${renderFactorBar('Academic Performance (40%)', riskData.details.academic, '#1a3c5e')}
            ${renderFactorBar('Attendance (25%)', riskData.details.attendance, '#4a90d9')}
            ${renderFactorBar('Assignments (15%)', riskData.details.assignments, '#d4a373')}
            ${renderFactorBar('Character (20%)', riskData.details.character, '#2d1a0e')}

            <hr style="border: 1px solid #d4a373; margin: 1rem 0;">

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:1.5rem;">
                <div>
                    <h4>⚠️ Warning Signs</h4>
                    ${warnings.length > 0 ? warnings.map(w =>
                        `<div style="padding:0.3rem 0; color:${w.color};">${w.icon} ${w.message}</div>`
                    ).join('') : '<div style="color:#166534;">✅ No warnings identified.</div>'}
                </div>
                <div>
                    <h4>💡 Recommendations</h4>
                    ${recommendations.map(r =>
                        `<div style="padding:0.3rem 0;">${r}</div>`
                    ).join('')}
                </div>
            </div>

            <p style="font-size:0.8rem; color:#6b3a2a; margin-top:1rem;">
                * Risk score is based on academic performance, attendance, assignments, and character assessment.
            </p>
        </div>
    `;

    container.innerHTML = html;
}

async function loadTeacherAIAnalytics() {
    const container = document.getElementById('teacherAIAnalyticsContainer');
    if (!container) return;

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
        container.innerHTML = '<p>Please log in.</p>';
        return;
    }

    const { data: teacher } = await supabaseClient
        .from('staff')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();

    if (!teacher) {
        container.innerHTML = '<p>Teacher profile not found.</p>';
        return;
    }

    const { data: teacherClasses } = await supabaseClient
        .from('teacher_classes')
        .select('class_id')
        .eq('teacher_id', teacher.id);

    if (!teacherClasses || teacherClasses.length === 0) {
        container.innerHTML = '<p>No students assigned to you.</p>';
        return;
    }

    const classIds = teacherClasses.map(tc => tc.class_id);

    const { data: students } = await supabaseClient
        .from('students')
        .select('id, full_name, admission_number, classes(name)')
        .in('class_id', classIds);

    if (!students || students.length === 0) {
        container.innerHTML = '<p>No students found.</p>';
        return;
    }

    let html = `
        <div class="glass-card">
            <h3>🤖 Class AI Risk Overview</h3>
            <p>Showing risk analysis for students in your classes.</p>
            <hr style="border: 1px solid #d4a373; margin: 1rem 0;">
            <div style="overflow-x:auto;">
                <table style="width:100%; border-collapse:collapse;">
                    <thead>
                        <tr style="background:#4a2c1a; color:white;">
                            <th style="padding:8px;">Student</th>
                            <th style="padding:8px;">Class</th>
                            <th style="padding:8px;">Risk Score</th>
                            <th style="padding:8px;">Risk Level</th>
                            <th style="padding:8px;">Action</th>
                        </tr>
                    </thead>
                    <tbody>
    `;

    for (const student of students) {
        const riskData = await calculateRiskScore(student.id);
        const riskColor = riskData.riskColor;
        const emoji = riskData.riskLevel === 'Low Risk' ? '✅' :
                     riskData.riskLevel === 'Moderate Risk' ? '⚠️' :
                     riskData.riskLevel === 'High Risk' ? '🚨' : '🚨🚨';

        html += `
            <tr style="border-bottom:1px solid #eee;">
                <td style="padding:8px;"><strong>${student.full_name}</strong></td>
                <td style="padding:8px;">${student.classes?.name || 'N/A'}</td>
                <td style="padding:8px; font-weight:bold; color:${riskColor};">${riskData.score}%</td>
                <td style="padding:8px; color:${riskColor};">${emoji} ${riskData.riskLevel}</td>
                <td style="padding:8px;">
                    <button onclick="viewStudentRisk(${student.id})" class="btn-secondary" style="padding:0.2rem 0.8rem; font-size:0.8rem; border:none; cursor:pointer;">
                        🔍 View
                    </button>
                </td>
            </tr>
        `;
    }

    html += `
                    </tbody>
                </table>
            </div>
        </div>
    `;

    container.innerHTML = html;
}

async function viewStudentRisk(studentId) {
    const container = document.getElementById('teacherStudentRiskContainer');
    if (!container) return;

    const { data: student } = await supabaseClient
        .from('students')
        .select('full_name, classes(name)')
        .eq('id', studentId)
        .single();

    if (!student) {
        container.innerHTML = '<p>Student not found.</p>';
        return;
    }

    const riskData = await calculateRiskScore(studentId);
    const warnings = getWarnings(riskData);
    const recommendations = getRecommendations(riskData);

    let html = `
        <div class="glass-card" style="margin-top:1rem;">
            <h3>🔍 Risk Analysis: ${student.full_name}</h3>
            <p><strong>Class:</strong> ${student.classes?.name || 'N/A'}</p>
            <hr style="border: 1px solid #d4a373; margin: 1rem 0;">

            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap;">
                <div>
                    <span style="font-size:2rem; font-weight:bold; color:${riskData.riskColor};">${riskData.score}%</span>
                    <span style="font-size:1.1rem; font-weight:bold; color:${riskData.riskColor};">${riskData.riskLevel}</span>
                </div>
                <div>
                    <span style="color:${riskData.riskColor};">${riskData.message}</span>
                </div>
            </div>

            <div style="width:100%; background:#e0e0e0; border-radius:10px; height:20px; margin-top:0.5rem; overflow:hidden;">
                <div style="width:${riskData.score}%; background:${riskData.riskColor}; height:100%; border-radius:10px;"></div>
            </div>

            <hr style="border: 1px solid #d4a373; margin: 1rem 0;">

            <h4>📊 Factor Breakdown</h4>
            ${renderFactorBar('Academic Performance (40%)', riskData.details.academic, '#1a3c5e')}
            ${renderFactorBar('Attendance (25%)', riskData.details.attendance, '#4a90d9')}
            ${renderFactorBar('Assignments (15%)', riskData.details.assignments, '#d4a373')}
            ${renderFactorBar('Character (20%)', riskData.details.character, '#2d1a0e')}

            <hr style="border: 1px solid #d4a373; margin: 1rem 0;">

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:1.5rem;">
                <div>
                    <h4>⚠️ Warning Signs</h4>
                    ${warnings.length > 0 ? warnings.map(w =>
                        `<div style="padding:0.3rem 0; color:${w.color};">${w.icon} ${w.message}</div>`
                    ).join('') : '<div style="color:#166534;">✅ No warnings identified.</div>'}
                </div>
                <div>
                    <h4>💡 Recommendations</h4>
                    ${recommendations.map(r =>
                        `<div style="padding:0.3rem 0;">${r}</div>`
                    ).join('')}
                </div>
            </div>

            <button onclick="document.getElementById('teacherStudentRiskContainer').innerHTML = ''" class="btn-secondary" style="margin-top:1rem; border:none; cursor:pointer;">
                Close
            </button>
        </div>
    `;

    container.innerHTML = html;
    container.scrollIntoView({ behavior: 'smooth' });
}

// ============================================================
// 5. AUTHENTICATION (FIXED ADMISSION NUMBER LOGIN)
// ============================================================
document.addEventListener('DOMContentLoaded', function() {

    // --- LOGIN (FIXED) ---
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const loginInput = document.getElementById('loginEmail').value.trim();
            const password = document.getElementById('loginPassword').value;
            const role = document.getElementById('loginRole').value;

            showMessage('loginMessage', 'Logging in...', false);

            let email = loginInput;

            if (!loginInput.includes('@')) {
                try {
                    // A dedicated, narrow lookup — doesn't expose anything
                    // else about the student, just resolves the email so
                    // Supabase Auth (which only knows email/password) can
                    // actually sign them in.
                    const { data: resolvedEmail, error: lookupError } = await supabaseClient
                        .rpc('get_email_by_admission_number', { p_admission_number: loginInput });

                    if (lookupError) {
                        console.error('Admission number lookup error:', lookupError);
                        showMessage('loginMessage', 'Error looking up admission number', true);
                        return;
                    }

                    if (resolvedEmail) {
                        email = resolvedEmail;
                    } else {
                        showMessage('loginMessage', 'Admission number not found. Please use email.', true);
                        return;
                    }
                } catch (err) {
                    console.error('Login error:', err);
                    showMessage('loginMessage', 'Error: ' + err.message, true);
                    return;
                }
            }

            const { data, error } = await supabaseClient.auth.signInWithPassword({
                email: email,
                password: password
            });

            if (error) {
                showMessage('loginMessage', error.message, true);
                return;
            }

            // Role is checked live from the users table now, not the login
            // token's cached data — that cached value can go stale the
            // moment someone's role is promoted/changed after they signed up.
            const { data: userRow } = await supabaseClient
                .from('users')
                .select('role')
                .eq('id', data.user.id)
                .maybeSingle();
            const userRole = userRow?.role;
            if (userRole !== role) {
                await supabaseClient.auth.signOut();
                showMessage('loginMessage', `You are not registered as a ${role}.`, true);
                return;
            }

            showMessage('loginMessage', 'Login successful! Redirecting...', false);
            setTimeout(() => {
                window.location.href = `dashboard-${role}.html`;
            }, 1000);
        });
    }

    // --- SIGNUP ---
    const signupForm = document.getElementById('signupForm');
    if (signupForm) {
        signupForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fullName = document.getElementById('fullName').value;
            const email = document.getElementById('signupEmail').value;
            const password = document.getElementById('signupPassword').value;
            const role = document.getElementById('signupRole').value;
            const classSelected = document.getElementById('signupClass')?.value;

            if (password.length < 6) {
                showMessage('signupMessage', 'Password must be at least 6 characters.', true);
                return;
            }

            const { data, error } = await supabaseClient.auth.signUp({
                email: email,
                password: password,
                options: {
                    data: {
                        full_name: fullName,
                        role: role,
                        class: classSelected || null
                    }
                }
            });

            if (error) {
                showMessage('signupMessage', error.message, true);
                return;
            }

            let admissionNumber = null;
            let teacherClaimed = false;
            let teacherPending = false;

            if (role === 'student') {
                // Check whether the admin already pre-registered this exact
                // email as a student (with no login yet) — if so, this signup
                // should "claim" that existing record instead of creating a
                // duplicate. This runs AFTER signUp() succeeds (using the
                // now-authenticated session) so RLS can safely restrict it to
                // only the record matching this person's own email.
                const { data: unclaimedStudent } = await supabaseClient
                    .from('students')
                    .select('id, admission_number')
                    .eq('email', email)
                    .is('user_id', null)
                    .maybeSingle();

                if (unclaimedStudent) {
                    const { error: claimError } = await supabaseClient
                        .from('students')
                        .update({ user_id: data.user.id })
                        .eq('id', unclaimedStudent.id);

                    if (claimError) console.error('Student claim error:', claimError);
                    admissionNumber = unclaimedStudent.admission_number;
                } else if (classSelected) {
                    const { data: classData } = await supabaseClient
                        .from('classes')
                        .select('id')
                        .eq('name', classSelected)
                        .single();

                    // Admission number assigned by the database (migration 18),
                    // so simultaneous signups can't collide on the same number.
                    const { data: insertedStudent, error: studentError } = await supabaseClient
                        .from('students')
                        .insert([{
                            full_name: fullName,
                            class_id: classData?.id || null,
                            user_id: data.user.id,
                            entry_point: classSelected,
                            email: email
                        }])
                        .select('admission_number')
                        .maybeSingle();

                    if (studentError) console.error('Student insert error:', studentError);
                    admissionNumber = insertedStudent?.admission_number || null;
                }
            } else if (role === 'teacher') {
                // Teacher access is only ever granted by claiming a staff
                // record the school admin already created (matching email).
                // Choosing "Teacher" in the dropdown alone does NOT grant
                // teacher access — that would be a security hole, since
                // anyone could just pick that option.
                const { data: unclaimedStaff } = await supabaseClient
                    .from('staff')
                    .select('id')
                    .eq('email', email)
                    .is('user_id', null)
                    .maybeSingle();

                if (unclaimedStaff) {
                    const { error: staffClaimError } = await supabaseClient
                        .from('staff')
                        .update({ user_id: data.user.id })
                        .eq('id', unclaimedStaff.id);

                    if (!staffClaimError) {
                        const { error: roleError } = await supabaseClient
                            .from('users')
                            .update({ role: 'teacher' })
                            .eq('id', data.user.id);
                        teacherClaimed = !roleError;
                    }
                    if (staffClaimError) console.error('Staff claim error:', staffClaimError);
                } else {
                    teacherPending = true;
                }
            }

            let resultMessage = '✅ Account created!';
            if (admissionNumber) resultMessage += ` Your Admission Number: ${admissionNumber}`;
            if (teacherClaimed) resultMessage += ' Your teacher profile is now linked — you can log in as a teacher.';
            if (teacherPending) resultMessage += ' No teacher profile matching this email was found yet — please ask the school admin to add you as staff with this exact email, then log in again.';

            showMessage('signupMessage', resultMessage, false);
            signupForm.reset();
        });
    }

    // --- LOGOUT ---
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            await supabaseClient.auth.signOut();
            window.location.href = 'index.html';
        });
    }

    // --- FORGOT PASSWORD ---
    const forgotPasswordForm = document.getElementById('forgotPasswordForm');
    if (forgotPasswordForm) {
        forgotPasswordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('resetEmail').value;
            const messageEl = document.getElementById('resetMessage');

            messageEl.textContent = 'Sending reset link...';
            messageEl.style.color = '#1a3c5e';

            const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
                redirectTo: window.location.origin + '/reset-password.html',
            });

            if (error) {
                messageEl.textContent = '❌ ' + error.message;
                messageEl.style.color = '#b91c1c';
            } else {
                messageEl.textContent = '✅ Reset link sent! Check your email.';
                messageEl.style.color = '#166534';
                setTimeout(() => {
                    document.getElementById('forgotPasswordModal').style.display = 'none';
                }, 3000);
            }
        });
    }

    // --- RESET PASSWORD ---
    const resetPasswordForm = document.getElementById('resetPasswordForm');
    if (resetPasswordForm) {
        resetPasswordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const newPassword = document.getElementById('newPassword').value;
            const confirmPassword = document.getElementById('confirmPassword').value;
            const messageEl = document.getElementById('resetMessage');

            if (newPassword.length < 6) {
                messageEl.textContent = '❌ Password must be at least 6 characters.';
                messageEl.style.color = '#b91c1c';
                return;
            }

            if (newPassword !== confirmPassword) {
                messageEl.textContent = '❌ Passwords do not match.';
                messageEl.style.color = '#b91c1c';
                return;
            }

            messageEl.textContent = 'Updating password...';
            messageEl.style.color = '#1a3c5e';

            const { error } = await supabaseClient.auth.updateUser({
                password: newPassword
            });

            if (error) {
                messageEl.textContent = '❌ ' + error.message;
                messageEl.style.color = '#b91c1c';
            } else {
                messageEl.textContent = '✅ Password reset successful! Redirecting...';
                messageEl.style.color = '#166534';
                setTimeout(() => {
                    window.location.href = 'login.html';
                }, 3000);
            }
        });
    }

    // --- PROTECT DASHBOARDS ---
    if (window.location.pathname.includes('dashboard-')) {
        protectDashboard();
    }

    // --- LOAD ADMIN DASHBOARD ---
    if (window.location.pathname.includes('dashboard-admin.html')) {
        loadTeachers();
        loadSubjects();
        loadStudents();
        loadClasses();
        loadDepartments();
        loadNews();
        loadClassTeachers();
        loadSubjectTeachers();
        loadTeacherAssignments();
        loadParentLinks();
        loadAcademicYears();
        loadTimetableManagerClasses();
        loadWeeklyScheduleClasses();
        loadPromoteClassDropdowns();
        populateReportFilterClasses();
        loadAdminOverviewStats();
        loadMyProfilePhoto();
        loadPrincipalSignaturePreview();
    }

    // --- LOAD TEACHER DASHBOARD ---
    if (window.location.pathname.includes('dashboard-teacher.html')) {
        loadTeacherSubjects();
        loadTeacherClasses();
        loadTeacherAttendanceClasses();
        loadCharacterAssessmentClasses();
        loadAssignmentSubjects();
        loadTeacherAIAnalytics();
    }

    // --- LOAD STUDENT DASHBOARD ---
    if (window.location.pathname.includes('dashboard-student.html')) {
        loadStudentProfile();
        loadStudentReport();
        loadStudentWeeklyAverages();
        loadStudentAttendance();
        loadStudentTimetable();
        loadStudentAIAnalytics();
    }

    // --- LOAD PARENT DASHBOARD ---
    if (window.location.pathname.includes('dashboard-parent.html')) {
        loadParentChildren();
    }

    // --- LOAD PUBLIC NEWS ---
    if (window.location.pathname.includes('news.html')) {
        loadPublicNews();
    }

    // --- LOAD PUBLIC STAFF ---
    if (window.location.pathname.includes('staff.html')) {
        loadPublicStaff();
    }

    // --- CONTACT FORM ---
    const contactForm = document.getElementById('contactForm');
    if (contactForm) {
        contactForm.addEventListener('submit', async function(e) {
            e.preventDefault();

            const name = document.getElementById('contactName').value;
            const email = document.getElementById('contactEmail').value;
            const message = document.getElementById('contactMessage').value;
            const statusEl = document.getElementById('contactMessageStatus');

            statusEl.textContent = '⏳ Sending message...';
            statusEl.style.color = '#1a3c5e';

            const html = `
                <h2>📩 New Contact Form Message</h2>
                <p><strong>Name:</strong> ${name}</p>
                <p><strong>Email:</strong> ${email}</p>
                <p><strong>Message:</strong></p>
                <p>${message}</p>
                <hr>
                <p><em>Sent from Wonderhills College contact form</em></p>
                <p>© 2026 Wonderhills College</p>
            `;

            try {
                const response = await fetch('https://tfradfxljdfcjenpuoxt.supabase.co/functions/v1/send-email', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
                    },
                    body: JSON.stringify({
                        to: 'wonderhills.sch@gmail.com',
                        subject: `📩 New Contact Form Message from ${name}`,
                        html: html
                    })
                });

                if (response.ok) {
                    statusEl.innerHTML = '✅ Message sent successfully! We will get back to you shortly.';
                    statusEl.style.color = '#166534';
                    this.reset();
                } else {
                    statusEl.innerHTML = '❌ Failed to send message. Please try again later.';
                    statusEl.style.color = '#b91c1c';
                }
            } catch (error) {
                console.error('Contact form error:', error);
                statusEl.innerHTML = '❌ Error sending message. Please try again.';
                statusEl.style.color = '#b91c1c';
            }
        });
    }
});

// ============================================================
// 6. DASHBOARD PROTECTION
// ============================================================
async function protectDashboard() {
    const { data: { user }, error } = await supabaseClient.auth.getUser();
    if (error || !user) {
        window.location.href = 'login.html';
        return;
    }

    const userInfoEl = document.getElementById('userInfo');
    if (userInfoEl) {
        const name = user.user_metadata?.full_name || user.email;
        // Read the role live from the users table, not the login token's
        // cached data — that cache is only ever set once at signup, so it
        // goes stale the moment someone is promoted afterward (like via
        // the "Promote User" tool or a direct database update).
        const { data: userRow } = await supabaseClient
            .from('users')
            .select('role')
            .eq('id', user.id)
            .maybeSingle();
        const role = userRow?.role || 'User';
        userInfoEl.innerHTML = `
            <div class="glass-card" style="text-align:center; max-width:600px; margin:0 auto;">
                <h3>Welcome, ${name}! 👋</h3>
                <p><strong>Role:</strong> ${role.charAt(0).toUpperCase() + role.slice(1)}</p>
                <p><strong>Email:</strong> ${user.email}</p>
                <button id="logoutBtn" class="btn-secondary" style="margin-top:1rem;">Logout</button>
            </div>
        `;
        document.getElementById('logoutBtn')?.addEventListener('click', async () => {
            await supabaseClient.auth.signOut();
            window.location.href = 'index.html';
        });
    }
}

// ============================================================
// 7. ADMIN FUNCTIONS
// ============================================================

// ----- TEACHERS -----
let allTeachersCache = [];

async function loadTeachers() {
    const container = document.getElementById('teacherList');
    if (!container) return;

    const { data, error } = await supabaseClient
        .from('staff')
        .select('*')
        .order('name');

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    allTeachersCache = data || [];
    renderTeacherList(allTeachersCache);
    populateTeacherDropdowns(allTeachersCache);
}

function renderTeacherList(data) {
    const container = document.getElementById('teacherList');
    if (!container) return;

    if (!data || data.length === 0) {
        container.innerHTML = '<p>No teachers added yet.</p>';
        return;
    }

    let html = '<ul style="list-style:none; padding:0;">';
    data.forEach(t => {
        html += `
            <li style="padding:0.5rem 0; border-bottom:1px solid #eee; display:flex; align-items:center; gap:0.6rem;">
                ${t.photo_url ? `<img src="${t.photo_url}" style="width:36px; height:36px; border-radius:50%; object-fit:cover; border:2px solid #d4a373;">` : ''}
                <div style="flex:1;">
                    <strong>${t.name}</strong><br>
                    ${t.qualification || ''} | ${t.subject || ''} | ${t.experience_years || 0} years
                </div>
                <button onclick="deleteTeacher(${t.id})" style="background:#b91c1c; color:white; border:none; border-radius:4px; padding:0.2rem 0.8rem; cursor:pointer;">Delete</button>
            </li>
        `;
    });
    html += '</ul>';
    container.innerHTML = html;
}

function filterTeacherList() {
    const query = document.getElementById('teacherSearchInput').value.toLowerCase().trim();
    if (!query) {
        renderTeacherList(allTeachersCache);
        return;
    }
    const filtered = allTeachersCache.filter(t =>
        t.name.toLowerCase().includes(query) ||
        (t.subject || '').toLowerCase().includes(query) ||
        (t.email || '').toLowerCase().includes(query)
    );
    renderTeacherList(filtered);
}

function populateTeacherDropdowns(teachers) {
    const selects = document.querySelectorAll('.teacher-select');
    selects.forEach(select => {
        const currentValue = select.value;
        select.innerHTML = '<option value="">Select Teacher</option>';
        teachers.forEach(t => {
            select.innerHTML += `<option value="${t.id}" ${t.id == currentValue ? 'selected' : ''}>${t.name}</option>`;
        });
    });
}

function showAddTeacherForm() {
    const container = document.getElementById('teacherFormContainer');
    if (container) {
        container.style.display = container.style.display === 'none' ? 'block' : 'none';
    }
}

async function saveTeacher() {
    const name = document.getElementById('teacherName').value;
    const email = document.getElementById('teacherEmail').value;
    const qualification = document.getElementById('teacherQualification').value;
    const subject = document.getElementById('teacherSubject').value;
    const experience = parseInt(document.getElementById('teacherExperience').value) || 0;
    const bio = document.getElementById('teacherBio')?.value || null;
    const photoFile = document.getElementById('teacherPhotoFile')?.files?.[0] || null;

    if (!name) {
        alert('Please enter the teacher\'s name.');
        return;
    }

    let photoUrl = null;

    if (photoFile) {
        const fileExt = photoFile.name.split('.').pop();
        const filePath = `staff/${Date.now()}_${Math.random().toString(36).slice(2)}.${fileExt}`;

        const { error: uploadError } = await supabaseClient
            .storage
            .from('staff-photos')
            .upload(filePath, photoFile, { upsert: true });

        if (uploadError) {
            alert('Error uploading photo: ' + uploadError.message + '\n(Make sure a public "staff-photos" bucket exists in Supabase Storage.)');
            return;
        }

        const { data: publicUrlData } = supabaseClient
            .storage
            .from('staff-photos')
            .getPublicUrl(filePath);

        photoUrl = publicUrlData?.publicUrl || null;
    }

    const { error } = await supabaseClient
        .from('staff')
        .insert([{
            name,
            email: email || null,
            qualification,
            subject,
            experience_years: experience,
            bio,
            photo_url: photoUrl
        }]);

    if (error) {
        alert('Error saving teacher: ' + error.message);
        return;
    }

    alert(`✅ Teacher saved successfully!${email ? '\n\nThey can now sign up as a Teacher using ' + email + ' and it will automatically link to this profile.' : '\n\nNo email was given — add one later if you want their account to auto-link when they sign up.'}`);
    document.getElementById('teacherName').value = '';
    document.getElementById('teacherEmail').value = '';
    document.getElementById('teacherQualification').value = '';
    document.getElementById('teacherSubject').value = '';
    document.getElementById('teacherExperience').value = '';
    if (document.getElementById('teacherBio')) document.getElementById('teacherBio').value = '';
    if (document.getElementById('teacherPhotoFile')) document.getElementById('teacherPhotoFile').value = '';
    if (document.getElementById('teacherPhotoPreview')) document.getElementById('teacherPhotoPreview').style.display = 'none';
    document.getElementById('teacherFormContainer').style.display = 'none';
    loadTeachers();
}

async function deleteTeacher(id) {
    if (!confirm('Are you sure you want to delete this teacher?')) return;
    const { error } = await supabaseClient.from('staff').delete().eq('id', id);
    if (error) {
        alert('Error: ' + error.message);
        return;
    }
    alert('✅ Teacher deleted.');
    loadTeachers();
}

// ----- SUBJECTS -----
let allSubjectsCache = [];

async function loadSubjects() {
    const container = document.getElementById('subjectList');
    if (!container) return;

    const { data, error } = await supabaseClient
        .from('subjects')
        .select('*, staff(name), classes(name)')
        .order('name');

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    allSubjectsCache = data || [];
    renderSubjectList(allSubjectsCache);
}

function renderSubjectList(subjects) {
    const container = document.getElementById('subjectList');
    if (!container) return;

    if (!subjects || subjects.length === 0) {
        container.innerHTML = '<p>No subjects added yet.</p>';
        return;
    }

    // Grouped by class and collapsed by default — with 20+ subjects across
    // several classes, a flat list becomes unusable fast.
    const grouped = {};
    subjects.forEach(s => {
        const className = s.classes?.name || 'Not Assigned';
        if (!grouped[className]) grouped[className] = [];
        grouped[className].push(s);
    });

    let html = '';
    Object.keys(grouped).sort().forEach(className => {
        const list = grouped[className];
        html += `
            <details style="margin-bottom:0.8rem; border:1px solid #eee; border-radius:8px; padding:0.5rem 1rem;">
                <summary style="cursor:pointer; font-weight:bold; color:#4a2c1a; padding:0.3rem 0;">
                    ${className} (${list.length} subject${list.length === 1 ? '' : 's'})
                </summary>
                <ul style="list-style:none; padding:0; margin-top:0.5rem;">
                    ${list.map(s => `
                        <li style="padding:0.5rem 0; border-bottom:1px solid #eee;">
                            <strong>${s.name}</strong><br>
                            Teacher: ${s.staff?.name || 'Not assigned'}
                            <button onclick="deleteSubject(${s.id})" style="float:right; background:#b91c1c; color:white; border:none; border-radius:4px; padding:0.2rem 0.8rem; cursor:pointer;">Delete</button>
                        </li>
                    `).join('')}
                </ul>
            </details>
        `;
    });
    container.innerHTML = html;
}

function filterSubjectList() {
    const query = document.getElementById('subjectSearchInput').value.toLowerCase().trim();
    if (!query) {
        renderSubjectList(allSubjectsCache);
        return;
    }
    const filtered = allSubjectsCache.filter(s =>
        s.name.toLowerCase().includes(query) ||
        (s.classes?.name || '').toLowerCase().includes(query) ||
        (s.staff?.name || '').toLowerCase().includes(query)
    );
    renderSubjectList(filtered);
}

function showAddSubjectForm() {
    const container = document.getElementById('subjectFormContainer');
    if (container) {
        container.style.display = container.style.display === 'none' ? 'block' : 'none';
        loadClassesDropdown();
        populateSubjectFormTeacherDropdown();
    }
}

async function populateSubjectFormTeacherDropdown() {
    const select = document.getElementById('subjectTeacher');
    if (!select) return;
    const { data: teachers } = await supabaseClient.from('staff').select('id, name').order('name');
    select.innerHTML = '<option value="">No teacher yet</option>' +
        (teachers || []).map(t => `<option value="${t.id}">${t.name}</option>`).join('');
}

async function loadClassesDropdown(targetId = 'subjectClass') {
    const select = document.getElementById(targetId);
    if (!select) return;

    const { data, error } = await supabaseClient
        .from('classes')
        .select('id, name')
        .order('name');

    if (error) return;

    select.innerHTML = '<option value="">Select Class</option>';
    data.forEach(c => {
        select.innerHTML += `<option value="${c.id}">${c.name}</option>`;
    });
}

async function saveSubject() {
    const name = document.getElementById('subjectName').value;
    const classId = document.getElementById('subjectClass').value;
    const teacherId = document.getElementById('subjectTeacher').value;

    if (!name || !classId) {
        alert('Please enter subject name and select a class.');
        return;
    }

    const { error } = await supabaseClient
        .from('subjects')
        .insert([{ name, class_id: classId, teacher_id: teacherId || null }]);

    if (error) {
        alert('Error saving subject: ' + error.message);
        return;
    }

    alert('✅ Subject saved successfully!');
    document.getElementById('subjectName').value = '';
    document.getElementById('subjectClass').value = '';
    document.getElementById('subjectTeacher').value = '';
    document.getElementById('subjectFormContainer').style.display = 'none';
    loadSubjects();
}

async function deleteSubject(id) {
    if (!confirm('Are you sure you want to delete this subject?')) return;
    const { error } = await supabaseClient.from('subjects').delete().eq('id', id);
    if (error) {
        alert('Error: ' + error.message);
        return;
    }
    alert('✅ Subject deleted.');
    loadSubjects();
}

// ----- STUDENTS -----
let allStudentsCache = [];
let allDepartmentsCache = [];

async function loadStudents() {
    const container = document.getElementById('studentList');
    if (!container) return;

    const { data, error } = await supabaseClient
        .from('students')
        .select('*, classes(name), departments(name)')
        .order('full_name');

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    const { data: depts } = await supabaseClient.from('departments').select('id, name').order('name');
    allDepartmentsCache = depts || [];

    allStudentsCache = data || [];
    renderStudentList(allStudentsCache);
}

function renderStudentList(students) {
    const container = document.getElementById('studentList');
    if (!container) return;

    if (!students || students.length === 0) {
        container.innerHTML = '<p>No students found.</p>';
        return;
    }

    // Grouped by class and collapsed by default — with hundreds of students,
    // one long flat list becomes unusable, so this keeps things scannable.
    const grouped = {};
    students.forEach(s => {
        const className = s.classes?.name || 'Not Assigned';
        if (!grouped[className]) grouped[className] = [];
        grouped[className].push(s);
    });

    const sortedClassNames = Object.keys(grouped).sort();

    let html = '';
    sortedClassNames.forEach(className => {
        const list = grouped[className];
        html += `
            <details style="margin-bottom:0.8rem; border:1px solid #eee; border-radius:8px; padding:0.5rem 1rem;">
                <summary style="cursor:pointer; font-weight:bold; color:#4a2c1a; padding:0.3rem 0;">
                    ${className} (${list.length} student${list.length === 1 ? '' : 's'})
                </summary>
                <ul style="list-style:none; padding:0; margin-top:0.5rem;">
                    ${list.map(s => `
                        <li style="padding:0.5rem 0; border-bottom:1px solid #eee; display:flex; align-items:flex-start; gap:0.6rem;">
                            ${s.photo_url ? `<img src="${s.photo_url}" style="width:36px; height:36px; border-radius:50%; object-fit:cover; border:2px solid #d4a373;">` : '<div style="width:36px; height:36px; border-radius:50%; background:#e0d6c8;"></div>'}
                            <div style="flex:1;">
                                <strong>${s.full_name}</strong><br>
                                Admission: ${s.admission_number || 'N/A'}${s.email ? ` | ${s.email}` : ''}
                                ${!s.user_id ? '<span style="color:#d79b00; font-size:0.8rem;"> (no login yet)</span>' : ''}
                                <br>
                                <label style="font-size:0.85rem; color:#6b3a2a;">Department: </label>
                                <select onchange="setStudentDepartment(${s.id}, this.value)" style="padding:0.2rem; border-radius:4px; border:1px solid #ccc; font-size:0.85rem;">
                                    <option value="">None</option>
                                    ${allDepartmentsCache.map(d => `<option value="${d.id}" ${s.department_id === d.id ? 'selected' : ''}>${d.name}</option>`).join('')}
                                </select>
                                <label class="btn-secondary" style="display:inline-block; cursor:pointer; padding:0.2rem 0.6rem; font-size:0.8rem; margin-left:0.3rem;">
                                    Photo
                                    <input type="file" accept="image/*" onchange="uploadStudentPhoto(${s.id}, this)" style="display:none;">
                                </label>
                            </div>
                            <button onclick="deleteStudent(${s.id})" style="background:#b91c1c; color:white; border:none; border-radius:4px; padding:0.2rem 0.8rem; cursor:pointer;">Delete</button>
                        </li>
                    `).join('')}
                </ul>
            </details>
        `;
    });

    container.innerHTML = html;
}

// Shared helper for the three new photo-upload use cases (student photos,
// admin's own photo, principal's signature) — all reuse the same
// already-public "staff-photos" bucket under different sub-paths.
async function uploadToStaffPhotosBucket(file, pathPrefix) {
    const fileExt = file.name.split('.').pop();
    const filePath = `${pathPrefix}/${Date.now()}_${Math.random().toString(36).slice(2)}.${fileExt}`;
    const { error: uploadError } = await supabaseClient.storage.from('staff-photos').upload(filePath, file, { upsert: true });
    if (uploadError) throw uploadError;
    const { data } = supabaseClient.storage.from('staff-photos').getPublicUrl(filePath);
    return data?.publicUrl || null;
}

async function uploadStudentPhoto(studentId, inputEl) {
    const file = inputEl.files?.[0];
    if (!file) return;

    try {
        const photoUrl = await uploadToStaffPhotosBucket(file, 'students');
        const { error } = await supabaseClient.from('students').update({ photo_url: photoUrl }).eq('id', studentId);
        if (error) throw error;

        const student = allStudentsCache.find(s => s.id === studentId);
        if (student) student.photo_url = photoUrl;
        renderStudentList(allStudentsCache);
    } catch (err) {
        alert('Error uploading photo: ' + err.message);
    }
}

async function uploadMyProfilePhoto(inputEl) {
    const file = inputEl.files?.[0];
    if (!file) return;

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return;

    try {
        const photoUrl = await uploadToStaffPhotosBucket(file, 'profiles');
        const { error } = await supabaseClient.from('users').update({ photo_url: photoUrl }).eq('id', user.id);
        if (error) throw error;
        alert('✅ Profile photo updated!');
        loadMyProfilePhoto();
    } catch (err) {
        alert('Error uploading photo: ' + err.message);
    }
}

async function loadMyProfilePhoto() {
    const container = document.getElementById('myProfilePhotoContainer');
    if (!container) return;

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return;

    const { data: userRow } = await supabaseClient.from('users').select('photo_url, full_name').eq('id', user.id).maybeSingle();
    const photoUrl = userRow?.photo_url;
    const initials = (userRow?.full_name || 'A').split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();

    container.innerHTML = `
        ${photoUrl
            ? `<img src="${photoUrl}" style="width:80px; height:80px; border-radius:50%; object-fit:cover; border:3px solid #d4a373;">`
            : `<div style="width:80px; height:80px; border-radius:50%; background:#d4a373; color:white; display:flex; align-items:center; justify-content:center; font-size:1.5rem; font-weight:bold;">${initials}</div>`
        }
        <label class="btn-secondary" style="display:inline-block; margin-top:0.5rem; cursor:pointer; padding:0.4rem 1rem; font-size:0.85rem;">
            Change Photo
            <input type="file" accept="image/*" onchange="uploadMyProfilePhoto(this)" style="display:none;">
        </label>
    `;
}

async function uploadPrincipalSignature(inputEl) {
    const file = inputEl.files?.[0];
    if (!file) return;

    try {
        const signatureUrl = await uploadToStaffPhotosBucket(file, 'signature');
        const { error } = await supabaseClient.from('school_settings').update({ principal_signature_url: signatureUrl }).eq('id', 1);
        if (error) throw error;
        alert('✅ Principal\'s signature updated! It will now appear on report cards.');
        loadPrincipalSignaturePreview();
    } catch (err) {
        alert('Error uploading signature: ' + err.message);
    }
}

async function loadPrincipalSignaturePreview() {
    const container = document.getElementById('principalSignaturePreview');
    if (!container) return;
    const { data } = await supabaseClient.from('school_settings').select('principal_signature_url').eq('id', 1).maybeSingle();
    container.innerHTML = data?.principal_signature_url
        ? `<img src="${data.principal_signature_url}" style="height:60px; background:white; padding:0.3rem; border-radius:4px;">`
        : '<p style="font-size:0.85rem; color:#666;">No signature uploaded yet — report cards will show a blank signature line instead.</p>';
}

async function setStudentDepartment(studentId, departmentId) {
    const { error } = await supabaseClient
        .from('students')
        .update({ department_id: departmentId || null })
        .eq('id', studentId);
    if (error) {
        alert('Error setting department: ' + error.message);
        return;
    }
    // Update the cache in place so the dropdown doesn't visually reset on next render
    const student = allStudentsCache.find(s => s.id === studentId);
    if (student) student.department_id = departmentId ? parseInt(departmentId) : null;
}

function filterStudentList() {
    const query = document.getElementById('studentSearchInput').value.toLowerCase().trim();
    if (!query) {
        renderStudentList(allStudentsCache);
        return;
    }
    const filtered = allStudentsCache.filter(s =>
        s.full_name.toLowerCase().includes(query) ||
        (s.admission_number || '').toLowerCase().includes(query) ||
        (s.email || '').toLowerCase().includes(query)
    );
    renderStudentList(filtered);
}

function showAddStudentForm() {
    const container = document.getElementById('studentFormContainer');
    if (container) {
        container.style.display = container.style.display === 'none' ? 'block' : 'none';
        loadClassesDropdown('studentClass');
    }
}

async function saveStudent() {
    const fullName = document.getElementById('studentName').value;
    const classId = document.getElementById('studentClass').value;
    const email = document.getElementById('studentEmail').value;

    if (!fullName || !classId) {
        alert('Please enter student name and select a class.');
        return;
    }

    // Admission number is assigned by the database itself (see migration 18),
    // which guarantees two students created at the same moment can never
    // receive the same number — that race was the cause of the intermittent
    // admission number failures.
    const { data: inserted, error } = await supabaseClient
        .from('students')
        .insert([{
            full_name: fullName,
            class_id: classId,
            user_id: null,
            email: email || null
        }])
        .select('admission_number')
        .maybeSingle();

    if (error) {
        alert('Error saving student: ' + error.message);
        return;
    }

    const admissionNumber = inserted?.admission_number || '(assigned)';

    alert(`✅ Student saved! Admission Number: ${admissionNumber}${email ? '\n\nThey can now sign up using ' + email + ' and it will automatically link to this record.' : '\n\nNo email was given — add one later if you want their account to auto-link when they sign up.'}`);
    document.getElementById('studentName').value = '';
    document.getElementById('studentClass').value = '';
    document.getElementById('studentEmail').value = '';
    document.getElementById('studentFormContainer').style.display = 'none';
    loadStudents();
}

async function deleteStudent(id) {
    if (!confirm('Delete this student permanently?\n\nThis will also permanently delete ALL of their weekly test scores, exam scores, attendance records, character assessments, and parent links. This cannot be undone.\n\nNote: if they already have a login account, that login is NOT deleted here — only their academic record. They would be able to log in to an empty dashboard afterward.')) return;
    const { error } = await supabaseClient.from('students').delete().eq('id', id);
    if (error) {
        alert('Error: ' + error.message);
        return;
    }
    alert('✅ Student deleted.');
    loadStudents();
}

// ----- CLASSES -----
async function loadClasses() {
    const container = document.getElementById('classList');
    if (!container) return;

    const { data, error } = await supabaseClient
        .from('classes')
        .select('*')
        .order('name');

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = '<p>No classes added yet.</p>';
        return;
    }

    let html = '<ul style="list-style:none; padding:0;">';
    data.forEach(c => {
        html += `
            <li style="padding:0.5rem 0; border-bottom:1px solid #eee;">
                <strong>${c.name}</strong> (${c.section})
                <button onclick="deleteClass(${c.id})" style="float:right; background:#b91c1c; color:white; border:none; border-radius:4px; padding:0.2rem 0.8rem; cursor:pointer;">Delete</button>
            </li>
        `;
    });
    html += '</ul>';
    container.innerHTML = html;
}

async function promoteUserRole() {
    const email = document.getElementById('promoteUserEmail').value;
    const newRole = document.getElementById('promoteUserRole').value;
    const statusEl = document.getElementById('promoteUserStatus');

    if (!email) {
        statusEl.textContent = '❌ Please enter an email.';
        statusEl.style.color = '#b91c1c';
        return;
    }

    const { data: existingUser, error: findError } = await supabaseClient
        .from('users')
        .select('id, role')
        .eq('email', email)
        .maybeSingle();

    if (findError || !existingUser) {
        statusEl.textContent = '❌ No account found with that email. They need to sign up first.';
        statusEl.style.color = '#b91c1c';
        return;
    }

    const { error: updateError } = await supabaseClient
        .from('users')
        .update({ role: newRole })
        .eq('id', existingUser.id);

    if (updateError) {
        statusEl.textContent = '❌ Error: ' + updateError.message;
        statusEl.style.color = '#b91c1c';
        return;
    }

    statusEl.textContent = `✅ ${email} is now ${newRole}. It takes effect immediately, no need for them to log out and back in.`;
    statusEl.style.color = '#166534';
    document.getElementById('promoteUserEmail').value = '';
}

// ============================================================
// PROMOTE STUDENTS (end of session: JSS1->JSS2, SS3->Graduated, etc)
// Snapshots each student's CURRENT class into student_term_classes for
// the active term BEFORE moving them — this is what keeps past report
// cards accurate even after their class_id changes going forward.
// ============================================================
async function loadPromoteClassDropdowns() {
    const { data: classes } = await supabaseClient.from('classes').select('id, name').order('name');
    ['promoteFromClass', 'promoteToClass'].forEach(id => {
        const select = document.getElementById(id);
        if (!select) return;
        select.innerHTML = '<option value="">Select a class...</option>' +
            (classes || []).map(c => `<option value="${c.id}">${c.name}</option>`).join('') +
            (id === 'promoteToClass' ? '<option value="GRADUATE">🎓 Graduate (remove from active roll)</option>' : '');
    });
}

async function promoteStudents() {
    const fromClassId = document.getElementById('promoteFromClass').value;
    const toValue = document.getElementById('promoteToClass').value;
    const statusEl = document.getElementById('promoteStatus');

    if (!fromClassId || !toValue) {
        statusEl.textContent = '❌ Please select both a source class and a destination.';
        statusEl.style.color = '#b91c1c';
        return;
    }

    const isGraduating = toValue === 'GRADUATE';
    if (!confirm(`This will move every student currently in this class ${isGraduating ? 'to Graduated status' : 'to the selected class'}. Their past report cards will be preserved exactly as they were. Continue?`)) return;

    statusEl.textContent = '⏳ Promoting students...';
    statusEl.style.color = '#1a3c5e';

    const { data: termData } = await supabaseClient.from('terms').select('id').eq('is_active', true).limit(1);
    const activeTermId = termData?.[0]?.id;

    const { data: students, error } = await supabaseClient
        .from('students')
        .select('id, class_id')
        .eq('class_id', fromClassId);

    if (error) {
        statusEl.textContent = '❌ Error: ' + error.message;
        statusEl.style.color = '#b91c1c';
        return;
    }

    if (!students || students.length === 0) {
        statusEl.textContent = '⚠️ No students found in that class.';
        statusEl.style.color = '#d79b00';
        return;
    }

    let errors = 0;
    for (const student of students) {
        // Snapshot their current class for the active term, so this
        // moment in history is preserved regardless of future changes.
        if (activeTermId) {
            await supabaseClient
                .from('student_term_classes')
                .upsert({ student_id: student.id, term_id: activeTermId, class_id: student.class_id }, { onConflict: 'student_id, term_id' });
        }

        const updatePayload = isGraduating
            ? { is_graduated: true, class_id: null }
            : { class_id: parseInt(toValue) };

        const { error: updateError } = await supabaseClient
            .from('students')
            .update(updatePayload)
            .eq('id', student.id);

        if (updateError) errors++;
    }

    if (errors > 0) {
        statusEl.textContent = `⚠️ Done, but ${errors} students had errors.`;
        statusEl.style.color = '#d79b00';
    } else {
        statusEl.textContent = `✅ ${students.length} students ${isGraduating ? 'marked as graduated' : 'promoted'} successfully!`;
        statusEl.style.color = '#166534';
    }
    loadStudents();
}

function showAddClassForm() {
    const container = document.getElementById('classFormContainer');
    if (container) {
        container.style.display = container.style.display === 'none' ? 'block' : 'none';
    }
}

// ============================================================
// MANAGE TERMS
// ============================================================
async function loadAcademicYears() {
    const container = document.getElementById('yearList');
    if (!container) return;

    const { data: years, error } = await supabaseClient
        .from('academic_years')
        .select('*')
        .order('id', { ascending: false });

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    if (!years || years.length === 0) {
        container.innerHTML = '<p>No academic years yet — add one to get started.</p>';
        return;
    }

    const { data: allTerms } = await supabaseClient
        .from('terms')
        .select('*')
        .order('id');

    let html = '';
    years.forEach(y => {
        const yearTerms = (allTerms || []).filter(t => t.year_id === y.id);
        html += `
            <details style="margin-bottom:0.8rem; border:1px solid #eee; border-radius:8px; padding:0.5rem 1rem;" ${y.is_current ? 'open' : ''}>
                <summary style="cursor:pointer; font-weight:bold; color:#4a2c1a; padding:0.3rem 0;">
                    📅 ${y.name} ${y.is_current ? '<span style="color:#166534;">(Current Year)</span>' : ''}
                    <div style="float:right;">
                        ${!y.is_current ? `<button onclick="setCurrentYear(${y.id})" class="btn-success" style="border:none; border-radius:4px; padding:0.2rem 0.8rem; cursor:pointer; font-size:0.8rem;">Set Current</button>` : ''}
                    </div>
                </summary>
                <div style="margin-top:0.8rem;">
                    <button onclick="showAddTermForm(${y.id})" class="btn-secondary" style="cursor:pointer; margin-bottom:0.6rem;">+ Add Term to this Year</button>
                    <ul style="list-style:none; padding:0;">
                        ${yearTerms.map(t => `
                            <li style="padding:0.5rem 0; border-bottom:1px solid #eee;">
                                <strong>${t.name}</strong> — ${t.weeks_count} week${t.weeks_count === 1 ? '' : 's'}
                                ${t.is_active ? '<span style="color:#166534; font-weight:bold;"> (Active)</span>' : ''}
                                ${t.results_published ? '<span style="color:#1a3c5e; font-weight:bold;"> (Results Published)</span>' : '<span style="color:#d79b00;"> (Results Not Published)</span>'}
                                ${t.next_term_begins ? `<br><small style="color:#666;">Next term begins: ${t.next_term_begins}</small>` : ''}
                                <div style="float:right;">
                                    ${!t.is_active ? `<button onclick="activateTerm(${t.id})" class="btn-success" style="border:none; border-radius:4px; padding:0.2rem 0.8rem; cursor:pointer; margin-right:0.3rem; font-size:0.8rem;">Set Active</button>` : ''}
                                    <button onclick="toggleResultsPublished(${t.id}, ${!t.results_published})" class="${t.results_published ? '' : 'btn-success'}" style="border:none; border-radius:4px; padding:0.2rem 0.8rem; cursor:pointer; margin-right:0.3rem; font-size:0.8rem; ${t.results_published ? 'background:#b91c1c; color:white;' : ''}">${t.results_published ? 'Unpublish Results' : 'Publish Results'}</button>
                                    <button onclick="editTermNextBegins(${t.id})" class="btn-secondary" style="border:none; border-radius:4px; padding:0.2rem 0.8rem; cursor:pointer; margin-right:0.3rem; font-size:0.8rem;">Set Next Term Date</button>
                                    <button onclick="deleteTerm(${t.id})" style="background:#b91c1c; color:white; border:none; border-radius:4px; padding:0.2rem 0.8rem; cursor:pointer; font-size:0.8rem;">Delete</button>
                                </div>
                                <div style="clear:both;"></div>
                            </li>
                        `).join('') || '<li style="color:#666;">No terms yet in this year.</li>'}
                    </ul>
                </div>
            </details>
        `;
    });
    container.innerHTML = html;

    populateTermDropdowns(allTerms || []);
}

function showAddYearForm() {
    const container = document.getElementById('yearFormContainer');
    if (container) {
        container.style.display = container.style.display === 'none' ? 'block' : 'none';
    }
}

async function saveAcademicYear() {
    const name = document.getElementById('yearName').value;
    if (!name) {
        alert('Please enter a year name (e.g. "2027").');
        return;
    }

    const { error } = await supabaseClient.from('academic_years').insert([{ name, is_current: false }]);
    if (error) {
        alert('Error saving year: ' + error.message);
        return;
    }

    document.getElementById('yearName').value = '';
    document.getElementById('yearFormContainer').style.display = 'none';
    loadAcademicYears();
}

async function setCurrentYear(yearId) {
    await supabaseClient.from('academic_years').update({ is_current: false }).eq('is_current', true);
    const { error } = await supabaseClient.from('academic_years').update({ is_current: true }).eq('id', yearId);
    if (error) {
        alert('Error: ' + error.message);
        return;
    }
    loadAcademicYears();
}

let selectedYearIdForTerm = null;

// These two class/student filter pairs (Download Reports card and Send
// Emails card) were previously referenced by onchange="" handlers that had
// no corresponding function at all — meaning both dropdowns were silently
// empty this whole time, regardless of what you selected.
async function populateReportFilterClasses() {
    const { data: classes } = await supabaseClient.from('classes').select('id, name').order('name');
    ['reportClassFilter', 'emailClassFilter', 'studentEmailClassFilter'].forEach(id => {
        const select = document.getElementById(id);
        if (!select) return;
        select.innerHTML = '<option value="">All Classes</option>' +
            (classes || []).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    });
}

async function populateReportStudentFilter() {
    const classId = document.getElementById('reportClassFilter').value;
    const select = document.getElementById('reportStudentFilter');
    if (!select) return;

    if (!classId) {
        select.innerHTML = '<option value="">Pick a class to list students, or leave blank for everyone</option>';
        return;
    }

    const { data: students } = await supabaseClient
        .from('students')
        .select('id, full_name, admission_number')
        .eq('class_id', classId)
        .order('full_name');

    select.innerHTML = (students || []).map(s => `<option value="${s.id}">${s.full_name} (${s.admission_number})</option>`).join('');
}

function getSelectedReportStudentIds() {
    const select = document.getElementById('reportStudentFilter');
    if (!select) return null;
    const selected = Array.from(select.selectedOptions).map(o => parseInt(o.value)).filter(v => !isNaN(v));
    return selected.length > 0 ? selected : null;
}

async function populateEmailStudentFilter() {
    const classId = document.getElementById('emailClassFilter').value;
    const select = document.getElementById('emailStudentFilter');
    if (!select) return;

    if (!classId) {
        select.innerHTML = '<option value="">All Students in Class</option>';
        return;
    }

    const { data: students } = await supabaseClient
        .from('students')
        .select('id, full_name, admission_number')
        .eq('class_id', classId)
        .order('full_name');

    select.innerHTML = '<option value="">All Students in Class</option>' +
        (students || []).map(s => `<option value="${s.id}">${s.full_name} (${s.admission_number})</option>`).join('');
}

async function populateStudentEmailStudentFilter() {
    const classId = document.getElementById('studentEmailClassFilter').value;
    const select = document.getElementById('studentEmailStudentFilter');
    if (!select) return;

    if (!classId) {
        select.innerHTML = '<option value="">All Students in Class</option>';
        return;
    }

    const { data: students } = await supabaseClient
        .from('students')
        .select('id, full_name, admission_number')
        .eq('class_id', classId)
        .order('full_name');

    select.innerHTML = '<option value="">All Students in Class</option>' +
        (students || []).map(s => `<option value="${s.id}">${s.full_name} (${s.admission_number})</option>`).join('');
}

function populateTermDropdowns(terms) {
    const activeTerm = terms.find(t => t.is_active) || terms[0];
    ['reportTermSelect', 'emailTermSelect', 'studentEmailTermSelect'].forEach(selectId => {
        const select = document.getElementById(selectId);
        if (!select) return;
        select.innerHTML = terms.map(t =>
            `<option value="${t.id}" ${t.id === activeTerm?.id ? 'selected' : ''}>${t.name}${t.is_active ? ' (Active)' : ''}</option>`
        ).join('');
    });
}

function showAddTermForm(yearId) {
    selectedYearIdForTerm = yearId;
    const container = document.getElementById('termFormContainer');
    if (container) {
        container.style.display = 'block';
        container.scrollIntoView({ behavior: 'smooth' });
    }
}

async function saveTerm() {
    const name = document.getElementById('termName').value;
    const weeksCount = parseInt(document.getElementById('termWeeksCount').value) || 8;

    if (!name) {
        alert('Please enter a term name (e.g. "First Term").');
        return;
    }
    if (!selectedYearIdForTerm) {
        alert('Please click "+ Add Term to this Year" under the specific year first.');
        return;
    }

    const { error } = await supabaseClient
        .from('terms')
        .insert([{ name, weeks_count: weeksCount, is_active: false, year_id: selectedYearIdForTerm }]);

    if (error) {
        alert('Error saving term: ' + error.message);
        return;
    }

    alert('✅ Term added! Click "Set Active" when you\'re ready to switch to it.');
    document.getElementById('termName').value = '';
    document.getElementById('termWeeksCount').value = '8';
    document.getElementById('termFormContainer').style.display = 'none';
    loadAcademicYears();
}

async function activateTerm(termId) {
    if (!confirm('Make this the active term? Teachers will then only be able to enter scores for this term.')) return;

    // Deactivate whatever is currently active, then activate the chosen one
    await supabaseClient.from('terms').update({ is_active: false }).eq('is_active', true);
    const { error } = await supabaseClient.from('terms').update({ is_active: true }).eq('id', termId);

    if (error) {
        alert('Error activating term: ' + error.message);
        return;
    }

    alert('✅ Term activated!');
    loadAcademicYears();
}

async function deleteTerm(termId) {
    if (!confirm('Delete this term? This will also delete all scores and attendance tied to it. This cannot be undone.')) return;

    const { error } = await supabaseClient.from('terms').delete().eq('id', termId);
    if (error) {
        alert('Error deleting term: ' + error.message);
        return;
    }
    loadAcademicYears();
}

async function toggleResultsPublished(termId, publish) {
    if (publish && !confirm('Publish results for this term? Students and parents will immediately be able to see report cards.')) return;
    const { error } = await supabaseClient.from('terms').update({ results_published: publish }).eq('id', termId);
    if (error) {
        alert('Error: ' + error.message);
        return;
    }
    loadAcademicYears();
}

async function editTermNextBegins(termId) {
    const dateValue = prompt('Enter the date next term begins (YYYY-MM-DD):');
    if (!dateValue) return;
    const { error } = await supabaseClient.from('terms').update({ next_term_begins: dateValue }).eq('id', termId);
    if (error) {
        alert('Error: ' + error.message);
        return;
    }
    loadAcademicYears();
}

async function saveClass() {
    const name = document.getElementById('className').value;
    const section = document.getElementById('classSection').value;

    if (!name || !section) {
        alert('Please enter class name and select section.');
        return;
    }

    const { error } = await supabaseClient
        .from('classes')
        .insert([{ name, section }]);

    if (error) {
        alert('Error saving class: ' + error.message);
        return;
    }

    alert('✅ Class saved successfully!');
    document.getElementById('className').value = '';
    document.getElementById('classSection').value = '';
    document.getElementById('classFormContainer').style.display = 'none';
    loadClasses();
}

async function deleteClass(id) {
    if (!confirm('Are you sure you want to delete this class?')) return;

    const { error } = await supabaseClient
        .from('classes')
        .delete()
        .eq('id', id);

    if (error) {
        alert('Error: ' + error.message);
        return;
    }

    alert('✅ Class deleted.');
    await loadClasses();
}

// ----- DEPARTMENTS -----
async function loadDepartments() {
    const container = document.getElementById('departmentList');
    if (!container) return;

    const { data, error } = await supabaseClient
        .from('departments')
        .select('*')
        .order('name');

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = '<p>No departments added yet.</p>';
        return;
    }

    let html = '<ul style="list-style:none; padding:0;">';
    data.forEach(d => {
        html += `
            <li style="padding:0.5rem 0; border-bottom:1px solid #eee;">
                <strong>${d.name}</strong>
                ${d.description ? `<br><span style="font-size:0.85rem; color:#666;">${d.description}</span>` : ''}
                <button onclick="deleteDepartment(${d.id})" style="float:right; background:#b91c1c; color:white; border:none; border-radius:4px; padding:0.2rem 0.8rem; cursor:pointer;">Delete</button>
            </li>
        `;
    });
    html += '</ul>';
    container.innerHTML = html;
}

function showAddDepartmentForm() {
    const container = document.getElementById('departmentFormContainer');
    if (container) {
        container.style.display = container.style.display === 'none' ? 'block' : 'none';
    }
}

async function saveDepartment() {
    const name = document.getElementById('departmentName').value;
    const description = document.getElementById('departmentDescription').value;

    if (!name) {
        alert('Please enter department name.');
        return;
    }

    const { error } = await supabaseClient
        .from('departments')
        .insert([{ name, description }]);

    if (error) {
        alert('Error saving department: ' + error.message);
        return;
    }

    alert('✅ Department saved successfully!');
    document.getElementById('departmentName').value = '';
    document.getElementById('departmentDescription').value = '';
    document.getElementById('departmentFormContainer').style.display = 'none';
    loadDepartments();
}

async function deleteDepartment(id) {
    if (!confirm('Are you sure you want to delete this department?')) return;
    const { error } = await supabaseClient.from('departments').delete().eq('id', id);
    if (error) {
        alert('Error: ' + error.message);
        return;
    }
    alert('✅ Department deleted.');
    loadDepartments();
}

// ----- NEWS -----
let allNewsCache = [];
let newsDisplayLimit = 10;

async function loadNews() {
    const container = document.getElementById('newsList');
    if (!container) return;

    const { data, error } = await supabaseClient
        .from('news')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    allNewsCache = data || [];
    newsDisplayLimit = 10;
    renderNewsList(allNewsCache);
}

function renderNewsList(newsItems) {
    const container = document.getElementById('newsList');
    if (!container) return;

    if (!newsItems || newsItems.length === 0) {
        container.innerHTML = '<p>No news posted yet.</p>';
        return;
    }

    const visible = newsItems.slice(0, newsDisplayLimit);

    let html = '<ul style="list-style:none; padding:0;">';
    visible.forEach(n => {
        const date = new Date(n.created_at).toLocaleDateString();
        html += `
            <li style="padding:0.5rem 0; border-bottom:1px solid #eee;">
                <strong>${n.title}</strong><br>
                <span style="font-size:0.9rem;">${n.content}</span><br>
                <small style="color:#999;">${date}</small>
                <button onclick="deleteNews(${n.id})" style="float:right; background:#b91c1c; color:white; border:none; border-radius:4px; padding:0.2rem 0.8rem; cursor:pointer;">Delete</button>
            </li>
        `;
    });
    html += '</ul>';

    if (newsItems.length > newsDisplayLimit) {
        html += `<button onclick="showMoreNews()" class="btn-secondary" style="margin-top:0.8rem; cursor:pointer;">Show ${Math.min(10, newsItems.length - newsDisplayLimit)} more (${newsItems.length - newsDisplayLimit} remaining)</button>`;
    }

    container.innerHTML = html;
}

function showMoreNews() {
    newsDisplayLimit += 10;
    const query = document.getElementById('newsSearchInput')?.value?.toLowerCase().trim();
    renderNewsList(query ? filterNewsData(query) : allNewsCache);
}

function filterNewsData(query) {
    return allNewsCache.filter(n =>
        n.title.toLowerCase().includes(query) || n.content.toLowerCase().includes(query)
    );
}

function filterNewsList() {
    const query = document.getElementById('newsSearchInput').value.toLowerCase().trim();
    newsDisplayLimit = 10;
    renderNewsList(query ? filterNewsData(query) : allNewsCache);
}

function showAddNewsForm() {
    const container = document.getElementById('newsFormContainer');
    if (container) {
        container.style.display = container.style.display === 'none' ? 'block' : 'none';
    }
}

async function saveNews() {
    const title = document.getElementById('newsTitle').value;
    const content = document.getElementById('newsContent').value;

    if (!title || !content) {
        alert('Please enter both title and content.');
        return;
    }

    const { error } = await supabaseClient
        .from('news')
        .insert([{ title, content }]);

    if (error) {
        alert('Error saving news: ' + error.message);
        return;
    }

    alert('✅ News saved successfully!');
    document.getElementById('newsTitle').value = '';
    document.getElementById('newsContent').value = '';
    document.getElementById('newsFormContainer').style.display = 'none';
    loadNews();
}

async function deleteNews(id) {
    if (!confirm('Are you sure you want to delete this news?')) return;
    const { error } = await supabaseClient.from('news').delete().eq('id', id);
    if (error) {
        alert('Error: ' + error.message);
        return;
    }
    alert('✅ News deleted.');
    loadNews();
}

// ----- CLASS TEACHERS -----
async function loadClassTeachers() {
    const container = document.getElementById('classTeacherList');
    if (!container) return;

    const { data, error } = await supabaseClient
        .from('class_teachers')
        .select('*, staff(name), classes(name)')
        .order('id');

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = '<p>No class teachers assigned yet.</p>';
        return;
    }

    let html = '<ul style="list-style:none; padding:0;">';
    data.forEach(ct => {
        html += `
            <li style="padding:0.5rem 0; border-bottom:1px solid #eee;">
                <strong>${ct.classes?.name || 'N/A'}</strong> → ${ct.staff?.name || 'Not assigned'}
                <button onclick="deleteClassTeacher(${ct.id})" style="float:right; background:#b91c1c; color:white; border:none; border-radius:4px; padding:0.2rem 0.8rem; cursor:pointer;">Remove</button>
            </li>
        `;
    });
    html += '</ul>';
    container.innerHTML = html;
}

// Populates the Class Teacher and Subject Teacher assignment dropdowns,
// which previously called loadTeachers()/loadClassesDropdown() — functions
// that actually target different elements elsewhere on the page, leaving
// these dropdowns permanently empty.
async function populateClassTeacherDropdowns() {
    const classSelect = document.getElementById('classTeacherClassSelect');
    const teacherSelect = document.getElementById('classTeacherSelect');

    const { data: classes } = await supabaseClient.from('classes').select('id, name').order('name');
    if (classSelect) {
        classSelect.innerHTML = '<option value="">Select Class</option>' +
            (classes || []).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    }

    const { data: teachers } = await supabaseClient.from('staff').select('id, name').order('name');
    if (teacherSelect) {
        teacherSelect.innerHTML = '<option value="">Select Teacher</option>' +
            (teachers || []).map(t => `<option value="${t.id}">${t.name}</option>`).join('');
    }
}

async function populateSubjectTeacherDropdowns() {
    const classSelect = document.getElementById('subjectTeacherClassSelect');
    const subjectSelect = document.getElementById('subjectTeacherSubjectSelect');
    const teacherSelect = document.getElementById('subjectTeacherSelect');

    const { data: classes } = await supabaseClient.from('classes').select('id, name').order('name');
    if (classSelect) {
        classSelect.innerHTML = '<option value="">Select Class</option>' +
            (classes || []).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    }

    const { data: teachers } = await supabaseClient.from('staff').select('id, name').order('name');
    if (teacherSelect) {
        teacherSelect.innerHTML = '<option value="">Select Teacher</option>' +
            (teachers || []).map(t => `<option value="${t.id}">${t.name}</option>`).join('');
    }

    if (subjectSelect) {
        subjectSelect.innerHTML = '<option value="">Select Class First</option>';
    }
}

// Subjects are tied to a specific class, so once a class is chosen,
// reload the subject dropdown to only show subjects from that class.
async function onSubjectTeacherClassChange() {
    const classId = document.getElementById('subjectTeacherClassSelect').value;
    const subjectSelect = document.getElementById('subjectTeacherSubjectSelect');
    if (!subjectSelect) return;

    if (!classId) {
        subjectSelect.innerHTML = '<option value="">Select Class First</option>';
        return;
    }

    const { data: subjects } = await supabaseClient
        .from('subjects')
        .select('id, name')
        .eq('class_id', classId)
        .order('name');

    subjectSelect.innerHTML = '<option value="">Select Subject</option>' +
        (subjects || []).map(s => `<option value="${s.id}">${s.name}</option>`).join('');
}

function showAddClassTeacherForm() {
    const container = document.getElementById('classTeacherFormContainer');
    if (container) {
        container.style.display = container.style.display === 'none' ? 'block' : 'none';
        populateClassTeacherDropdowns();
    }
}

async function saveClassTeacher() {
    const teacherId = document.getElementById('classTeacherSelect').value;
    const classId = document.getElementById('classTeacherClassSelect').value;

    if (!teacherId || !classId) {
        alert('Please select both teacher and class.');
        return;
    }

    const { error } = await supabaseClient
        .from('class_teachers')
        .insert([{ teacher_id: teacherId, class_id: classId }]);

    if (error) {
        alert('Error assigning class teacher: ' + error.message);
        return;
    }

    alert('✅ Class teacher assigned successfully!');
    document.getElementById('classTeacherFormContainer').style.display = 'none';
    loadClassTeachers();
}

async function deleteClassTeacher(id) {
    if (!confirm('Remove this class teacher?')) return;
    const { error } = await supabaseClient.from('class_teachers').delete().eq('id', id);
    if (error) {
        alert('Error: ' + error.message);
        return;
    }
    alert('✅ Class teacher removed.');
    loadClassTeachers();
}

// ----- SUBJECT TEACHERS -----
async function loadSubjectTeachers() {
    const container = document.getElementById('subjectTeacherList');
    if (!container) return;

    const { data, error } = await supabaseClient
        .from('teacher_classes')
        .select('*, staff(name), subjects(name), classes(name)')
        .order('id');

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = '<p>No subject teachers assigned yet.</p>';
        return;
    }

    // Grouped by class and collapsed by default — 20+ subjects across 6
    // classes can mean 100+ assignments in this list otherwise.
    const grouped = {};
    data.forEach(tc => {
        const className = tc.classes?.name || 'Not Assigned';
        if (!grouped[className]) grouped[className] = [];
        grouped[className].push(tc);
    });

    let html = '';
    Object.keys(grouped).sort().forEach(className => {
        const list = grouped[className];
        html += `
            <details style="margin-bottom:0.8rem; border:1px solid #eee; border-radius:8px; padding:0.5rem 1rem;">
                <summary style="cursor:pointer; font-weight:bold; color:#4a2c1a; padding:0.3rem 0;">
                    ${className} (${list.length} assignment${list.length === 1 ? '' : 's'})
                </summary>
                <ul style="list-style:none; padding:0; margin-top:0.5rem;">
                    ${list.map(tc => `
                        <li style="padding:0.5rem 0; border-bottom:1px solid #eee;">
                            <strong>${tc.subjects?.name || 'N/A'}</strong> → ${tc.staff?.name || 'Not assigned'}
                            <button onclick="deleteSubjectTeacher(${tc.id})" style="float:right; background:#b91c1c; color:white; border:none; border-radius:4px; padding:0.2rem 0.8rem; cursor:pointer;">Remove</button>
                        </li>
                    `).join('')}
                </ul>
            </details>
        `;
    });
    container.innerHTML = html;
}

function showAddSubjectTeacherForm() {
    const container = document.getElementById('subjectTeacherFormContainer');
    if (container) {
        container.style.display = container.style.display === 'none' ? 'block' : 'none';
        populateSubjectTeacherDropdowns();
    }
}

async function saveSubjectTeacher() {
    const teacherId = document.getElementById('subjectTeacherSelect').value;
    const subjectId = document.getElementById('subjectTeacherSubjectSelect').value;
    const classId = document.getElementById('subjectTeacherClassSelect').value;

    if (!teacherId || !subjectId || !classId) {
        alert('Please select teacher, subject, and class.');
        return;
    }

    const { error } = await supabaseClient
        .from('teacher_classes')
        .insert([{ teacher_id: teacherId, subject_id: subjectId, class_id: classId }]);

    if (error) {
        alert('Error assigning subject teacher: ' + error.message);
        return;
    }

    alert('✅ Subject teacher assigned successfully!');
    document.getElementById('subjectTeacherFormContainer').style.display = 'none';
    loadSubjectTeachers();
}

async function deleteSubjectTeacher(id) {
    if (!confirm('Remove this subject teacher?')) return;
    const { error } = await supabaseClient.from('teacher_classes').delete().eq('id', id);
    if (error) {
        alert('Error: ' + error.message);
        return;
    }
    alert('✅ Subject teacher removed.');
    loadSubjectTeachers();
}

// ============================================================
// 8. TEACHER ASSIGNMENT FUNCTIONS
// ============================================================

async function loadTeacherAssignments() {
    const container = document.getElementById('assignTeacherList');
    if (!container) return;

    const { data, error } = await supabaseClient
        .from('teacher_classes')
        .select('*, staff(name), subjects(name), classes(name)')
        .order('id');

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = '<p>No teachers assigned to classes yet.</p>';
        return;
    }

    let html = '<ul style="list-style:none; padding:0;">';
    data.forEach(tc => {
        html += `
            <li style="padding:0.5rem 0; border-bottom:1px solid #eee;">
                <strong>${tc.staff?.name || 'Unknown'}</strong> teaches 
                <strong>${tc.subjects?.name || 'Unknown'}</strong> in 
                <strong>${tc.classes?.name || 'Unknown'}</strong>
                <button onclick="deleteTeacherAssignment(${tc.id})" style="float:right; background:#b91c1c; color:white; border:none; border-radius:4px; padding:0.2rem 0.8rem; cursor:pointer;">Remove</button>
            </li>
        `;
    });
    html += '</ul>';
    container.innerHTML = html;
}

function showAssignTeacherForm() {
    const container = document.getElementById('assignTeacherFormContainer');
    if (container) {
        container.style.display = container.style.display === 'none' ? 'block' : 'none';
        loadTeachers();
        loadClassesDropdown();
        loadSubjectsDropdown();
    }
}

async function loadSubjectsDropdown() {
    const select = document.getElementById('assignSubjectSelect');
    if (!select) return;

    const { data, error } = await supabaseClient
        .from('subjects')
        .select('id, name')
        .order('name');

    if (error) return;

    select.innerHTML = '<option value="">Select Subject</option>';
    data.forEach(s => {
        select.innerHTML += `<option value="${s.id}">${s.name}</option>`;
    });
}

async function assignTeacherToClass() {
    const teacherId = document.getElementById('assignTeacherSelect').value;
    const classId = document.getElementById('assignClassSelect').value;
    const subjectId = document.getElementById('assignSubjectSelect').value;

    if (!teacherId || !classId || !subjectId) {
        alert('Please select teacher, class, and subject.');
        return;
    }

    const { error } = await supabaseClient
        .from('teacher_classes')
        .insert([{ teacher_id: teacherId, class_id: classId, subject_id: subjectId }]);

    if (error) {
        alert('Error: ' + error.message);
        return;
    }

    alert('✅ Teacher assigned successfully!');
    document.getElementById('assignTeacherFormContainer').style.display = 'none';
    loadTeacherAssignments();
}

async function deleteTeacherAssignment(id) {
    if (!confirm('Remove this assignment?')) return;
    const { error } = await supabaseClient
        .from('teacher_classes')
        .delete()
        .eq('id', id);
    if (error) {
        alert('Error: ' + error.message);
        return;
    }
    alert('✅ Assignment removed.');
    loadTeacherAssignments();
}

// ============================================================
// 9. TEACHER FUNCTIONS
// ============================================================

let currentSubjectId = null;
let currentTermId = null;

async function loadTeacherSubjects() {
    const container = document.getElementById('teacherSubjectArea');
    if (!container) return;

    const { data: { user } } = await supabaseClient.auth.getUser();
    const { data: teacher } = await supabaseClient
        .from('staff')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();

    if (!teacher) {
        container.innerHTML = '<p>Teacher profile not found.</p>';
        return;
    }

    const { data, error } = await supabaseClient
        .from('teacher_classes')
        .select('*, subjects(name, id), classes(name, id)')
        .eq('teacher_id', teacher.id);

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = `
            <div class="glass-card" style="text-align:center;">
                <p>📭 No subjects assigned to you yet.</p>
                <p style="font-size:0.9rem; color:#6b3a2a;">Please contact the administrator.</p>
            </div>
        `;
        return;
    }

    // Grouped by subject, each with its classes listed underneath —
    // a flat wall of buttons breaks down fast once someone teaches
    // several subjects across several classes (e.g. 9 subjects × 6
    // classes would be 54 buttons crammed together otherwise).
    const bySubject = {};
    data.forEach(tc => {
        const subjectName = tc.subjects?.name || 'Unknown Subject';
        if (!bySubject[subjectName]) bySubject[subjectName] = [];
        bySubject[subjectName].push(tc);
    });

    const sortedSubjectNames = Object.keys(bySubject).sort();

    let html = `<h3>My Subjects</h3>`;
    sortedSubjectNames.forEach(subjectName => {
        const entries = bySubject[subjectName];
        html += `
            <details style="margin-bottom:0.8rem; border:1px solid #eee; border-radius:8px; padding:0.5rem 1rem;" open>
                <summary style="cursor:pointer; font-weight:bold; color:#4a2c1a; padding:0.3rem 0;">
                    📖 ${subjectName} (${entries.length} class${entries.length === 1 ? '' : 'es'})
                </summary>
                <div style="display:flex; gap:0.6rem; flex-wrap:wrap; margin-top:0.6rem;">
                    ${entries.map(tc => `
                        <button onclick="loadStudentsForSubject(${tc.subject_id}, ${tc.class_id})"
                                class="btn-secondary" style="padding:0.5rem 1.2rem; cursor:pointer;">
                            ${tc.classes?.name || 'N/A'}
                        </button>
                    `).join('')}
                </div>
            </details>
        `;
    });
    html += `<div id="studentListArea" style="margin-top:2rem;"></div>`;
    container.innerHTML = html;
}

let currentWeekNumber = 1;
let currentTermWeeksCount = 8;

async function loadStudentsForSubject(subjectId, classId) {
    currentSubjectId = subjectId;
    const area = document.getElementById('studentListArea');
    area.innerHTML = '<p>Loading students...</p>';

    const { data: termData } = await supabaseClient
        .from('terms')
        .select('id, weeks_count, name')
        .eq('is_active', true)
        .limit(1);
    currentTermId = termData?.[0]?.id || 1;
    currentTermWeeksCount = termData?.[0]?.weeks_count || 8;

    // Only weeks the admin has actually approved for THIS subject/class
    // show up here — this is a hard requirement, also enforced at the
    // database level, so a teacher genuinely cannot enter a score for a
    // week that wasn't approved.
    const { data: approvedWeeks } = await supabaseClient
        .from('weekly_test_schedule')
        .select('week_number')
        .eq('subject_id', subjectId)
        .eq('class_id', classId)
        .eq('term_id', currentTermId)
        .order('week_number');

    const weekOptions = [...new Set((approvedWeeks || []).map(w => w.week_number))];

    if (weekOptions.length === 0) {
        area.innerHTML = `
            <div class="glass-card" style="text-align:center;">
                <p>📭 No weeks have been approved yet for this subject in this class.</p>
                <p style="font-size:0.9rem; color:#6b3a2a;">Ask the admin to approve this subject under "Weekly Test Schedule" before you can enter scores.</p>
            </div>
        `;
        return;
    }

    if (!weekOptions.includes(currentWeekNumber)) currentWeekNumber = weekOptions[0];

    const { data: students, error } = await supabaseClient
        .from('students')
        .select('id, full_name, admission_number')
        .eq('class_id', classId);

    if (error) {
        area.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    if (!students || students.length === 0) {
        area.innerHTML = `<p>No students found in this class.</p>`;
        return;
    }

    let html = `
        <h4>Enter Weekly Scores</h4>
        <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.8rem;">
            <label for="weeklyScoreWeekSelect" style="font-weight:600; margin:0;">Week:</label>
            <select id="weeklyScoreWeekSelect" onchange="onWeeklyScoreWeekChange(${subjectId}, ${classId})" style="width:auto; padding:0.4rem;">
                ${weekOptions.map(w =>
                    `<option value="${w}" ${w === currentWeekNumber ? 'selected' : ''}>Week ${w}</option>`
                ).join('')}
            </select>
            <small style="color:#666;">(only weeks admin approved for this subject show here)</small>
        </div>
        <p><small>Weekly Tests (Max 100 marks)</small></p>
        <div style="overflow-x:auto;">
        <table>
            <thead>
                <tr style="background:#4a2c1a; color:white;">
                    <th style="padding:8px;">Student</th>
                    <th style="padding:8px;">Admission</th>
                    <th style="padding:8px;">Score (100)</th>
                    <th style="padding:8px;">Action</th>
                </tr>
            </thead>
            <tbody>
    `;

    for (const student of students) {
        const { data: existing } = await supabaseClient
            .from('weekly_test_results')
            .select('score')
            .eq('student_id', student.id)
            .eq('subject_id', subjectId)
            .eq('week_number', currentWeekNumber)
            .eq('term_id', currentTermId)
            .maybeSingle();

        const score = existing?.score || '';

        html += `
            <tr>
                <td style="padding:8px;"><strong>${student.full_name}</strong></td>
                <td style="padding:8px;">${student.admission_number}</td>
                <td style="padding:8px;">
                    <input type="number" min="0" max="100" value="${score}" 
                           style="width:80px; padding:4px;" 
                           id="score_${student.id}" />
                </td>
                <td style="padding:8px;">
                    <button onclick="saveWeeklyScore(${student.id}, ${subjectId})" 
                            class="btn-primary" style="padding:2px 12px; font-size:0.8rem; border:none; cursor:pointer;">
                        💾 Save
                    </button>
                </td>
            </tr>
        `;
    }

    html += `
            </tbody>
        </table>
        <div id="saveStatus" style="margin-top:1rem; font-weight:bold;"></div>
        </div>
    `;

    area.innerHTML = html;
}

function onWeeklyScoreWeekChange(subjectId, classId) {
    const select = document.getElementById('weeklyScoreWeekSelect');
    currentWeekNumber = parseInt(select.value) || 1;
    loadStudentsForSubject(subjectId, classId);
}

async function saveWeeklyScore(studentId, subjectId) {
    const statusEl = document.getElementById('saveStatus');
    const input = document.getElementById(`score_${studentId}`);
    const score = parseInt(input.value);

    if (isNaN(score) || score < 0 || score > 100) {
        statusEl.textContent = '❌ Please enter a valid score (0-100).';
        statusEl.style.color = '#b91c1c';
        return;
    }

    statusEl.textContent = '⏳ Saving...';
    statusEl.style.color = '#1a3c5e';

    const { error } = await supabaseClient
        .from('weekly_test_results')
        .upsert({
            student_id: studentId,
            subject_id: subjectId,
            week_number: currentWeekNumber,
            term_id: currentTermId,
            score: score
        }, { onConflict: 'student_id, subject_id, week_number, term_id' });

    if (error) {
        statusEl.textContent = '❌ Error: ' + error.message;
        statusEl.style.color = '#b91c1c';
    } else {
        statusEl.textContent = '✅ Score saved successfully!';
        statusEl.style.color = '#166534';
    }
}

async function loadTeacherClasses() {
    const container = document.getElementById('teacherClassList');
    if (!container) return;

    const { data: { user } } = await supabaseClient.auth.getUser();
    const { data: teacher } = await supabaseClient
        .from('staff')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();

    if (!teacher) {
        container.innerHTML = '<p>Teacher profile not found.</p>';
        return;
    }

    const { data, error } = await supabaseClient
        .from('class_teachers')
        .select('*, classes(name, id)')
        .eq('teacher_id', teacher.id);

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = '<p>You are not assigned as a class teacher.</p>';
        return;
    }

    let html = `<h3>My Classes</h3><div style="display:flex; gap:1rem; flex-wrap:wrap; margin-bottom:1rem;">`;
    data.forEach(ct => {
        html += `
            <button onclick="loadClassStudents(${ct.class_id})" 
                    class="btn-secondary" style="padding:0.6rem 1.5rem; cursor:pointer;">
                📚 ${ct.classes?.name || 'Unknown'}
            </button>
        `;
    });
    html += `</div><div id="classStudentArea" style="margin-top:2rem;"></div>`;
    container.innerHTML = html;
}

async function loadClassStudents(classId) {
    const area = document.getElementById('classStudentArea');
    area.innerHTML = '<p>Loading students...</p>';

    const { data: subjects } = await supabaseClient
        .from('subjects')
        .select('id, name')
        .eq('class_id', classId);

    const { data: students, error } = await supabaseClient
        .from('students')
        .select('id, full_name, admission_number')
        .eq('class_id', classId);

    if (error) {
        area.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    if (!students || students.length === 0) {
        area.innerHTML = '<p>No students found in this class.</p>';
        return;
    }

    const { data: termData } = await supabaseClient
        .from('terms')
        .select('id')
        .eq('is_active', true)
        .limit(1);
    currentTermId = termData?.[0]?.id || 1;

    const { data: existingScores } = await supabaseClient
        .from('exam_scores')
        .select('*')
        .eq('term_id', currentTermId);

    let html = `
        <h4>Enter Exam Scores (Report Card)</h4>
        <p><small>End of Term Exam (Max 75 marks)</small></p>
        <div style="overflow-x:auto;">
        <table>
            <thead>
                <tr style="background:#4a2c1a; color:white;">
                    <th style="padding:8px;">Student</th>
                    ${subjects.map(s => `<th style="padding:8px;">${s.name}</th>`).join('')}
                    <th style="padding:8px;">Action</th>
                </tr>
            </thead>
            <tbody>
    `;

    for (const student of students) {
        html += `<tr><td style="padding:8px;"><strong>${student.full_name}</strong></td>`;

        for (const subject of subjects) {
            const existing = existingScores?.find(e => e.student_id === student.id && e.subject_id === subject.id);
            const val = existing?.exam_score || '';
            html += `
                <td style="padding:8px;">
                    <input type="number" min="0" max="75" value="${val}" 
                           style="width:60px; padding:4px;" 
                           id="exam_${student.id}_${subject.id}" />
                </td>
            `;
        }

        html += `
            <td style="padding:8px;">
                <button onclick="saveExamScores(${student.id}, ${classId})" 
                        class="btn-primary" style="padding:2px 12px; font-size:0.8rem; border:none; cursor:pointer;">
                    💾 Save
                </button>
            </td>
        </tr>`;
    }

    html += `
            </tbody>
        </table>
        <div id="examSaveStatus" style="margin-top:1rem; font-weight:bold;"></div>
        </div>
    `;

    area.innerHTML = html;
}

async function saveExamScores(studentId, classId) {
    const statusEl = document.getElementById('examSaveStatus');
    statusEl.textContent = '⏳ Saving exam scores...';
    statusEl.style.color = '#1a3c5e';

    const { data: subjects } = await supabaseClient
        .from('subjects')
        .select('id')
        .eq('class_id', classId);

    let errors = 0;

    for (const subject of subjects) {
        const input = document.getElementById(`exam_${studentId}_${subject.id}`);
        if (!input) continue;

        const score = parseInt(input.value);
        if (isNaN(score) || score < 0) continue;

        const { error } = await supabaseClient
            .from('exam_scores')
            .upsert({
                student_id: studentId,
                subject_id: subject.id,
                term_id: currentTermId,
                exam_score: Math.min(75, score)
            }, { onConflict: 'student_id, subject_id, term_id' });

        if (error) errors++;
    }

    if (errors > 0) {
        statusEl.textContent = `⚠️ ${errors} errors occurred.`;
        statusEl.style.color = '#b91c1c';
    } else {
        statusEl.textContent = '✅ Exam scores saved successfully!';
        statusEl.style.color = '#166534';
    }
}

async function loadTeacherAttendanceClasses() {
    const container = document.getElementById('attendanceClassList');
    if (!container) return;

    const { data: { user } } = await supabaseClient.auth.getUser();
    const { data: teacher } = await supabaseClient
        .from('staff')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();

    if (!teacher) {
        container.innerHTML = '<p>Teacher profile not found.</p>';
        return;
    }

    const { data, error } = await supabaseClient
        .from('class_teachers')
        .select('*, classes(name, id)')
        .eq('teacher_id', teacher.id);

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = '<p>You are not assigned as a class teacher.</p>';
        return;
    }

    let html = `<h4>Select a Class to Mark Attendance</h4><div style="display:flex; gap:1rem; flex-wrap:wrap; margin-bottom:1rem;">`;
    data.forEach(ct => {
        html += `
            <button onclick="loadAttendanceStudents(${ct.class_id})" 
                    class="btn-secondary" style="padding:0.6rem 1.5rem; cursor:pointer;">
                📋 ${ct.classes?.name || 'Unknown'}
            </button>
        `;
    });
    html += `</div>`;
    container.innerHTML = html;
}

let selectedAttendanceClassId = null;

let selectedAttendanceDate = null;

let selectedAttendanceSession = 'Morning';

async function loadAttendanceStudents(classId, dateOverride, sessionOverride) {
    selectedAttendanceClassId = classId;
    selectedAttendanceDate = dateOverride || new Date().toISOString().split('T')[0];
    selectedAttendanceSession = sessionOverride || 'Morning';
    const area = document.getElementById('attendanceStudentList');
    const attendanceArea = document.getElementById('attendanceArea');
    attendanceArea.style.display = 'block';
    area.innerHTML = '<p>Loading students...</p>';

    const { data: students, error } = await supabaseClient
        .from('students')
        .select('id, full_name, admission_number')
        .eq('class_id', classId);

    if (error || !students || students.length === 0) {
        area.innerHTML = '<p>No students found in this class.</p>';
        return;
    }

    const { data: existingAttendance } = await supabaseClient
        .from('attendance')
        .select('student_id, status')
        .eq('class_id', classId)
        .eq('date', selectedAttendanceDate)
        .eq('session', selectedAttendanceSession);

    const today = new Date().toISOString().split('T')[0];

    let html = `
        <h4>Mark Attendance</h4>
        <div style="display:flex; align-items:center; gap:1rem; margin-bottom:0.8rem; flex-wrap:wrap;">
            <div>
                <label for="attendanceDatePicker" style="font-weight:600; margin:0;">Date:</label>
                <input type="date" id="attendanceDatePicker" value="${selectedAttendanceDate}" max="${today}"
                       onchange="loadAttendanceStudents(${classId}, this.value, selectedAttendanceSession)"
                       style="padding:0.4rem; border-radius:4px; border:1px solid #ccc;">
            </div>
            <div>
                <label for="attendanceSessionPicker" style="font-weight:600; margin:0;">Session:</label>
                <select id="attendanceSessionPicker" onchange="loadAttendanceStudents(${classId}, selectedAttendanceDate, this.value)" style="padding:0.4rem; border-radius:4px; border:1px solid #ccc;">
                    <option value="Morning" ${selectedAttendanceSession === 'Morning' ? 'selected' : ''}>🌅 Morning</option>
                    <option value="Afternoon" ${selectedAttendanceSession === 'Afternoon' ? 'selected' : ''}>☀️ Afternoon</option>
                </select>
            </div>
        </div>
        <div style="overflow-x:auto;"><table>
        <thead><tr style="background:#4a2c1a; color:white;">
            <th style="padding:8px;">Student</th>
            <th style="padding:8px;">Admission</th>
            <th style="padding:8px;">Status</th>
        </tr></thead><tbody>`;

    for (const student of students) {
        const existing = existingAttendance?.find(a => a.student_id === student.id);
        const status = existing?.status || 'Present';
        html += `
            <tr>
                <td style="padding:8px;"><strong>${student.full_name}</strong></td>
                <td style="padding:8px;">${student.admission_number}</td>
                <td style="padding:8px;">
                    <select id="attendance_${student.id}" style="padding:0.4rem; border-radius:4px; border:1px solid #ccc;">
                        <option value="Present" ${status === 'Present' ? 'selected' : ''}>✅ Present</option>
                        <option value="Late" ${status === 'Late' ? 'selected' : ''}>⏰ Late</option>
                        <option value="Absent" ${status === 'Absent' ? 'selected' : ''}>❌ Absent</option>
                    </select>
                </td>
            </tr>
        `;
    }

    html += `</tbody></table></div>`;
    area.innerHTML = html;
}

async function saveAttendance() {
    const statusEl = document.getElementById('attendanceStatus');
    statusEl.textContent = '⏳ Saving attendance...';
    statusEl.style.color = '#1a3c5e';

    const attendanceDate = selectedAttendanceDate || new Date().toISOString().split('T')[0];
    const { data: { user } } = await supabaseClient.auth.getUser();
    const { data: teacher } = await supabaseClient
        .from('staff')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();

    if (!teacher) {
        statusEl.textContent = '❌ Teacher not found.';
        statusEl.style.color = '#b91c1c';
        return;
    }

    const { data: students } = await supabaseClient
        .from('students')
        .select('id')
        .eq('class_id', selectedAttendanceClassId);

    if (!students || students.length === 0) {
        statusEl.textContent = '❌ No students found.';
        statusEl.style.color = '#b91c1c';
        return;
    }

    let errors = 0;
    for (const student of students) {
        const statusSelect = document.getElementById(`attendance_${student.id}`);
        if (statusSelect) {
            const { error } = await supabaseClient
                .from('attendance')
                .upsert({
                    student_id: student.id,
                    class_id: selectedAttendanceClassId,
                    date: attendanceDate,
                    session: selectedAttendanceSession || 'Morning',
                    status: statusSelect.value,
                    teacher_id: teacher.id
                }, { onConflict: 'student_id, class_id, date, session' });

            if (error) errors++;
        }
    }

    if (errors > 0) {
        statusEl.textContent = `⚠️ ${errors} errors occurred.`;
        statusEl.style.color = '#b91c1c';
    } else {
        statusEl.textContent = '✅ Attendance saved successfully!';
        statusEl.style.color = '#166534';
    }
}

// ============================================================
// CHARACTER ASSESSMENT (homeroom/class teacher, once per term)
// Feeds both the report card's "Character Assessment" section
// and part of the AI risk score — previously had no input form
// anywhere, so this was always blank no matter what.
// ============================================================
async function loadCharacterAssessmentClasses() {
    const container = document.getElementById('characterClassList');
    if (!container) return;

    const { data: { user } } = await supabaseClient.auth.getUser();
    const { data: teacher } = await supabaseClient
        .from('staff')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();

    if (!teacher) {
        container.innerHTML = '<p>Teacher profile not found.</p>';
        return;
    }

    const { data, error } = await supabaseClient
        .from('class_teachers')
        .select('*, classes(name, id)')
        .eq('teacher_id', teacher.id);

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = '<p>You are not assigned as a class teacher, so this isn\'t available to you — only homeroom teachers assess character.</p>';
        return;
    }

    let html = `<h4>Select a Class to Assess</h4><div style="display:flex; gap:1rem; flex-wrap:wrap; margin-bottom:1rem;">`;
    data.forEach(ct => {
        html += `
            <button onclick="loadCharacterAssessmentStudents(${ct.class_id})"
                    class="btn-secondary" style="padding:0.6rem 1.5rem; cursor:pointer;">
                🌟 ${ct.classes?.name || 'Unknown'}
            </button>
        `;
    });
    html += `</div>`;
    container.innerHTML = html;
}

let selectedCharacterClassId = null;
let currentCharacterTermId = null;

const CHARACTER_TRAITS = [
    { key: 'honesty', label: 'Honesty' },
    { key: 'hardwork', label: 'Hardwork' },
    { key: 'intelligence', label: 'Intelligence' },
    { key: 'neatness', label: 'Neatness' },
    { key: 'use_of_initiative', label: 'Use of Initiative' }
];

async function loadCharacterAssessmentStudents(classId) {
    selectedCharacterClassId = classId;
    const area = document.getElementById('characterStudentList');
    const characterArea = document.getElementById('characterArea');
    characterArea.style.display = 'block';
    area.innerHTML = '<p>Loading students...</p>';

    const { data: termData } = await supabaseClient
        .from('terms')
        .select('id, name')
        .eq('is_active', true)
        .limit(1);
    const term = termData?.[0] || { id: 1, name: 'Current Term' };
    currentCharacterTermId = term.id;

    const { data: students, error } = await supabaseClient
        .from('students')
        .select('id, full_name, admission_number')
        .eq('class_id', classId);

    if (error || !students || students.length === 0) {
        area.innerHTML = '<p>No students found in this class.</p>';
        return;
    }

    const { data: existingAssessments } = await supabaseClient
        .from('character_assessment')
        .select('*')
        .eq('term_id', term.id)
        .in('student_id', students.map(s => s.id));

    const ratingOptions = ['Excellent', 'Good', 'Credit', 'Fair', 'Poor'];
    const ratingShort = { Excellent: 'E', Good: 'G', Credit: 'C', Fair: 'F', Poor: 'P' };

    let html = `
        <h4>Character Assessment</h4>
        <p><small>Term: ${term.name}</small></p>
        <p style="font-size:0.85rem; color:#666;">
            E = Excellent &nbsp; G = Good &nbsp; C = Credit &nbsp; F = Fair &nbsp; P = Poor
            &nbsp;|&nbsp;
            <span style="color:#000000; font-weight:bold;">E</span> ·
            <span style="color:#1a3c5e; font-weight:bold;">G / C</span> ·
            <span style="color:#b91c1c; font-weight:bold;">F / P</span>
        </p>
        <div style="overflow-x:auto;"><table>
        <thead><tr style="background:#4a2c1a; color:white;">
            <th style="padding:8px;">Student</th>
            ${CHARACTER_TRAITS.map(t => `<th style="padding:8px;">${t.label}</th>`).join('')}
            <th style="padding:8px;">Remark</th>
        </tr></thead><tbody>`;

    for (const student of students) {
        const existing = existingAssessments?.find(a => a.student_id === student.id);
        html += `<tr><td style="padding:8px;"><strong>${student.full_name}</strong><br><small>${student.admission_number}</small></td>`;
        CHARACTER_TRAITS.forEach(trait => {
            const currentValue = existing?.[trait.key] || 'Good';
            html += `
                <td style="padding:8px;">
                    <select id="character_${trait.key}_${student.id}" style="padding:0.4rem; border-radius:4px; border:1px solid #ccc; color:${getCharacterColor(currentValue)}; font-weight:bold;" onchange="this.style.color = getCharacterColor(this.value)">
                        ${ratingOptions.map(opt => `<option value="${opt}" ${currentValue === opt ? 'selected' : ''} style="color:${getCharacterColor(opt)};">${ratingShort[opt]}</option>`).join('')}
                    </select>
                </td>
            `;
        });
        html += `
            <td style="padding:8px;">
                <textarea id="remark_${student.id}" rows="1" placeholder="Class teacher's remark..." style="width:180px; padding:0.4rem; border-radius:4px; border:1px solid #ccc;">${existing?.class_teacher_remark || ''}</textarea>
            </td>
        `;
        html += `</tr>`;
    }

    html += `</tbody></table></div>`;
    area.innerHTML = html;
}

async function saveCharacterAssessments() {
    const statusEl = document.getElementById('characterStatus');
    statusEl.textContent = '⏳ Saving character assessments...';
    statusEl.style.color = '#1a3c5e';

    const { data: students } = await supabaseClient
        .from('students')
        .select('id')
        .eq('class_id', selectedCharacterClassId);

    if (!students || students.length === 0) {
        statusEl.textContent = '❌ No students found.';
        statusEl.style.color = '#b91c1c';
        return;
    }

    let errors = 0;
    for (const student of students) {
        const record = { student_id: student.id, term_id: currentCharacterTermId };
        let hasAllFields = true;
        CHARACTER_TRAITS.forEach(trait => {
            const select = document.getElementById(`character_${trait.key}_${student.id}`);
            if (select) {
                record[trait.key] = select.value;
            } else {
                hasAllFields = false;
            }
        });

        if (!hasAllFields) continue;

        const remarkEl = document.getElementById(`remark_${student.id}`);
        if (remarkEl) record.class_teacher_remark = remarkEl.value || null;

        const { error } = await supabaseClient
            .from('character_assessment')
            .upsert(record, { onConflict: 'student_id, term_id' });

        if (error) errors++;
    }

    if (errors > 0) {
        statusEl.textContent = `⚠️ ${errors} errors occurred.`;
        statusEl.style.color = '#b91c1c';
    } else {
        statusEl.textContent = '✅ Character assessments saved successfully!';
        statusEl.style.color = '#166534';
    }
}

// ============================================================
// ASSIGNMENTS (create + track completion per subject/class)
// ============================================================
async function loadAssignmentSubjects() {
    const container = document.getElementById('assignmentSubjectArea');
    if (!container) return;

    const { data: { user } } = await supabaseClient.auth.getUser();
    const { data: teacher } = await supabaseClient
        .from('staff')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();

    if (!teacher) {
        container.innerHTML = '<p>Teacher profile not found.</p>';
        return;
    }

    const { data, error } = await supabaseClient
        .from('teacher_classes')
        .select('*, subjects(name, id), classes(name, id)')
        .eq('teacher_id', teacher.id);

    if (error || !data || data.length === 0) {
        container.innerHTML = `<div class="glass-card" style="text-align:center;"><p>📭 No subjects assigned to you yet.</p></div>`;
        return;
    }

    const bySubject = {};
    data.forEach(tc => {
        const subjectName = tc.subjects?.name || 'Unknown Subject';
        if (!bySubject[subjectName]) bySubject[subjectName] = [];
        bySubject[subjectName].push(tc);
    });

    let html = '';
    Object.keys(bySubject).sort().forEach(subjectName => {
        const entries = bySubject[subjectName];
        html += `
            <details style="margin-bottom:0.8rem; border:1px solid #eee; border-radius:8px; padding:0.5rem 1rem;">
                <summary style="cursor:pointer; font-weight:bold; color:#4a2c1a; padding:0.3rem 0;">
                    📝 ${subjectName} (${entries.length} class${entries.length === 1 ? '' : 'es'})
                </summary>
                <div style="display:flex; gap:0.6rem; flex-wrap:wrap; margin-top:0.6rem;">
                    ${entries.map(tc => `
                        <button onclick="loadAssignmentsForSubjectClass(${tc.subject_id}, ${tc.class_id})"
                                class="btn-secondary" style="padding:0.5rem 1.2rem; cursor:pointer;">
                            ${tc.classes?.name || 'N/A'}
                        </button>
                    `).join('')}
                </div>
            </details>
        `;
    });
    html += `<div id="assignmentArea" style="margin-top:2rem;"></div>`;
    container.innerHTML = html;
}

let selectedAssignmentSubjectId = null;
let selectedAssignmentClassId = null;
let selectedAssignmentTermId = null;

async function loadAssignmentsForSubjectClass(subjectId, classId) {
    selectedAssignmentSubjectId = subjectId;
    selectedAssignmentClassId = classId;
    const area = document.getElementById('assignmentArea');
    area.innerHTML = '<p>Loading assignments...</p>';

    const { data: termData } = await supabaseClient
        .from('terms')
        .select('id, name')
        .eq('is_active', true)
        .limit(1);
    const term = termData?.[0] || { id: 1, name: 'Current Term' };
    selectedAssignmentTermId = term.id;

    const { data: assignments, error } = await supabaseClient
        .from('assignments')
        .select('id, title, description, due_date')
        .eq('subject_id', subjectId)
        .eq('class_id', classId)
        .eq('term_id', term.id)
        .order('due_date');

    if (error) {
        area.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    let html = `
        <h4>Assignments — ${term.name}</h4>
        <div style="margin-bottom:1rem;">
            <input type="text" id="newAssignmentTitle" placeholder="Assignment title" style="width:100%; margin-bottom:0.5rem; padding:0.5rem;">
            <input type="date" id="newAssignmentDueDate" style="width:100%; margin-bottom:0.5rem; padding:0.5rem;">
            <button onclick="createAssignment()" class="btn-primary" style="border:none; cursor:pointer; padding:0.5rem 1.5rem;">+ Create Assignment</button>
        </div>
        <div id="assignmentListArea"></div>
    `;
    area.innerHTML = html;

    if (!assignments || assignments.length === 0) {
        document.getElementById('assignmentListArea').innerHTML = '<p>No assignments created yet for this subject/class this term.</p>';
        return;
    }

    let listHtml = '';
    assignments.forEach(a => {
        listHtml += `
            <div style="border:1px solid #eee; border-radius:8px; padding:0.8rem 1rem; margin-bottom:0.6rem;">
                <strong>${a.title}</strong> ${a.due_date ? `<span style="font-size:0.85rem; color:#666;">— due ${a.due_date}</span>` : ''}
                <button onclick="loadAssignmentCompletion(${a.id})" class="btn-secondary" style="float:right; padding:0.3rem 1rem; cursor:pointer;">Mark Completion</button>
                <div style="clear:both;"></div>
            </div>
        `;
    });
    document.getElementById('assignmentListArea').innerHTML = listHtml + '<div id="assignmentCompletionArea" style="margin-top:1.5rem;"></div>';
}

async function createAssignment() {
    const title = document.getElementById('newAssignmentTitle').value;
    const dueDate = document.getElementById('newAssignmentDueDate').value;

    if (!title) {
        alert('Please enter an assignment title.');
        return;
    }

    const { data: { user } } = await supabaseClient.auth.getUser();
    const { data: teacher } = await supabaseClient.from('staff').select('id').eq('user_id', user.id).maybeSingle();

    const { error } = await supabaseClient
        .from('assignments')
        .insert([{
            subject_id: selectedAssignmentSubjectId,
            class_id: selectedAssignmentClassId,
            term_id: selectedAssignmentTermId,
            teacher_id: teacher?.id || null,
            title,
            due_date: dueDate || null
        }]);

    if (error) {
        alert('Error creating assignment: ' + error.message);
        return;
    }

    loadAssignmentsForSubjectClass(selectedAssignmentSubjectId, selectedAssignmentClassId);
}

async function loadAssignmentCompletion(assignmentId) {
    const area = document.getElementById('assignmentCompletionArea');
    area.innerHTML = '<p>Loading students...</p>';

    const { data: students } = await supabaseClient
        .from('students')
        .select('id, full_name, admission_number')
        .eq('class_id', selectedAssignmentClassId);

    if (!students || students.length === 0) {
        area.innerHTML = '<p>No students found in this class.</p>';
        return;
    }

    const { data: existing } = await supabaseClient
        .from('assignment_submissions')
        .select('student_id, completed, score')
        .eq('assignment_id', assignmentId);

    let html = `<h5>Mark Completion</h5><div style="overflow-x:auto;"><table>
        <thead><tr style="background:#4a2c1a; color:white;">
            <th style="padding:8px;">Student</th>
            <th style="padding:8px;">Completed</th>
            <th style="padding:8px;">Score (optional)</th>
        </tr></thead><tbody>`;

    students.forEach(student => {
        const record = existing?.find(e => e.student_id === student.id);
        html += `
            <tr>
                <td style="padding:8px;">${student.full_name}<br><small>${student.admission_number}</small></td>
                <td style="padding:8px;"><input type="checkbox" id="completed_${student.id}" ${record?.completed ? 'checked' : ''} style="width:20px; height:20px;"></td>
                <td style="padding:8px;"><input type="number" id="score_assign_${student.id}" value="${record?.score ?? ''}" style="width:80px; padding:0.4rem;"></td>
            </tr>
        `;
    });

    html += `</tbody></table></div>
        <button onclick="saveAssignmentCompletion(${assignmentId})" class="btn-primary" style="margin-top:1rem; border:none; cursor:pointer; padding:0.6rem 1.5rem;">💾 Save Completion</button>
        <div id="assignmentCompletionStatus" style="margin-top:0.8rem; font-weight:bold;"></div>
    `;
    area.innerHTML = html;
}

async function saveAssignmentCompletion(assignmentId) {
    const statusEl = document.getElementById('assignmentCompletionStatus');
    statusEl.textContent = '⏳ Saving...';
    statusEl.style.color = '#1a3c5e';

    const { data: students } = await supabaseClient
        .from('students')
        .select('id')
        .eq('class_id', selectedAssignmentClassId);

    let errors = 0;
    for (const student of students) {
        const checkbox = document.getElementById(`completed_${student.id}`);
        const scoreInput = document.getElementById(`score_assign_${student.id}`);
        if (!checkbox) continue;

        const { error } = await supabaseClient
            .from('assignment_submissions')
            .upsert({
                assignment_id: assignmentId,
                student_id: student.id,
                completed: checkbox.checked,
                score: scoreInput.value ? parseFloat(scoreInput.value) : null,
                submitted_at: checkbox.checked ? new Date().toISOString() : null
            }, { onConflict: 'assignment_id, student_id' });

        if (error) errors++;
    }

    if (errors > 0) {
        statusEl.textContent = `⚠️ ${errors} errors occurred.`;
        statusEl.style.color = '#b91c1c';
    } else {
        statusEl.textContent = '✅ Completion saved!';
        statusEl.style.color = '#166534';
    }
}

// ============================================================
// 10. STUDENT FUNCTIONS
// ============================================================

async function loadStudentProfile() {
    const container = document.getElementById('studentProfile');
    if (!container) return;

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return;

    const { data: student } = await supabaseClient
        .from('students')
        .select('*, classes(name)')
        .eq('user_id', user.id)
        .maybeSingle();

    if (!student) {
        container.innerHTML = '<p>Student profile not found.</p>';
        return;
    }

    const initials = student.full_name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
    container.innerHTML = `
        <div class="glass-card" style="display:flex; align-items:center; gap:1.2rem;">
            ${student.photo_url
                ? `<img src="${student.photo_url}" style="width:70px; height:70px; border-radius:50%; object-fit:cover; border:3px solid #d4a373;">`
                : `<div style="width:70px; height:70px; border-radius:50%; background:#d4a373; color:white; display:flex; align-items:center; justify-content:center; font-size:1.3rem; font-weight:bold;">${initials}</div>`
            }
            <div>
                <h3 style="margin:0;">My Profile</h3>
                <p style="margin:0.3rem 0 0;"><strong>Name:</strong> ${student.full_name}</p>
                <p style="margin:0.2rem 0 0;"><strong>Admission:</strong> ${student.admission_number}</p>
                <p style="margin:0.2rem 0 0;"><strong>Class:</strong> ${student.classes?.name || 'N/A'}</p>
            </div>
        </div>
    `;
}

async function getPrincipalSignatureUrl() {
    const { data } = await supabaseClient.from('school_settings').select('principal_signature_url').eq('id', 1).maybeSingle();
    return data?.principal_signature_url || null;
}

async function loadStudentReport() {
    const container = document.getElementById('reportContainer');
    if (!container) return;

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
        container.innerHTML = '<p>Please log in to view your report.</p>';
        return;
    }

    const { data: studentData } = await supabaseClient
        .from('students')
        .select('id, full_name, admission_number, class_id, classes(name)')
        .eq('user_id', user.id)
        .maybeSingle();

    if (!studentData) {
        container.innerHTML = `<div class="glass-card"><p>No student record found.</p></div>`;
        return;
    }

    const studentId = studentData.id;

    const { data: termData } = await supabaseClient
        .from('terms')
        .select('id, name, next_term_begins, results_published')
        .eq('is_active', true)
        .limit(1);
    const term = termData?.[0] || { id: 1, name: 'Current Term' };

    if (!term.results_published) {
        container.innerHTML = `
            <div class="glass-card" style="text-align:center;">
                <h3>Results Not Yet Published</h3>
                <p>Your report card for ${term.name} will appear here once the school publishes results.</p>
            </div>
        `;
        return;
    }

    const { data: weeklyData } = await supabaseClient
        .from('weekly_test_results')
        .select('subject_id, week_number, score, subjects(name)')
        .eq('student_id', studentId)
        .eq('term_id', term.id);

    const { data: examData } = await supabaseClient
        .from('exam_scores')
        .select('subject_id, exam_score, teacher_comment, subjects(name)')
        .eq('student_id', studentId)
        .eq('term_id', term.id);

    const { data: characterData } = await supabaseClient
        .from('character_assessment')
        .select('*')
        .eq('student_id', studentId)
        .eq('term_id', term.id)
        .maybeSingle();

    const positionData = studentData.class_id
        ? await computeReportCardPositions(studentId, studentData.class_id, term.id)
        : null;
    const signatureUrl = await getPrincipalSignatureUrl();

    const cardHtml = renderReportCardHTML(studentData, weeklyData, examData, characterData, term.name, positionData, term, signatureUrl);

    container.innerHTML = `
        ${cardHtml}
        <div style="margin-top: 1.5rem; text-align: center;">
            <button onclick="window.print()" class="btn-primary" style="border:none; cursor:pointer; padding:0.8rem 2rem;">
                Print / Download as PDF
            </button>
        </div>
    `;
}

async function loadStudentWeeklyAverages() {
    const container = document.getElementById('weeklyAveragesContainer');
    if (!container) return;

    const { data: { user } } = await supabaseClient.auth.getUser();
    const { data: studentData } = await supabaseClient
        .from('students')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();

    if (!studentData) {
        container.innerHTML = '<p>No student record found.</p>';
        return;
    }

    const { data: termData } = await supabaseClient
        .from('terms')
        .select('id')
        .eq('is_active', true)
        .limit(1);
    const termId = termData?.[0]?.id || 1;

    // Since teachers can only ever enter a score for an admin-approved
    // subject/week, every row here is already guaranteed to belong to a
    // genuinely scheduled test — no extra filtering needed to get an
    // accurate "average of subjects actually tested that week".
    const { data: scores } = await supabaseClient
        .from('weekly_test_results')
        .select('week_number, score')
        .eq('student_id', studentData.id)
        .eq('term_id', termId);

    if (!scores || scores.length === 0) {
        container.innerHTML = '<p>No weekly scores recorded yet this term.</p>';
        return;
    }

    const byWeek = {};
    scores.forEach(s => {
        if (!byWeek[s.week_number]) byWeek[s.week_number] = [];
        byWeek[s.week_number].push(s.score);
    });

    const weeks = Object.keys(byWeek).map(Number).sort((a, b) => a - b);

    let html = '<div style="display:flex; gap:1rem; flex-wrap:wrap;">';
    weeks.forEach(week => {
        const avg = byWeek[week].reduce((sum, s) => sum + s, 0) / byWeek[week].length;
        const color = avg >= 70 ? '#166534' : avg >= 50 ? '#d79b00' : '#b91c1c';
        html += `
            <div class="glass-card" style="flex:1 1 120px; text-align:center; padding:1rem;">
                <div style="font-size:0.85rem; color:#6b3a2a;">Week ${week}</div>
                <div style="font-size:1.5rem; font-weight:bold; color:${color};">${avg.toFixed(1)}%</div>
                <div style="font-size:0.75rem; color:#999;">${byWeek[week].length} subject${byWeek[week].length === 1 ? '' : 's'}</div>
            </div>
        `;
    });
    html += '</div>';
    container.innerHTML = html;
}

// Groups attendance records into a weekly grid — Monday to Friday columns,
// one row per week — instead of a flat chronological list. Only real
// marked records ever appear; there's never a fabricated blank day.
function renderAttendanceGrid(records) {
    function getMonday(dateStr) {
        const d = new Date(dateStr);
        const day = d.getDay();
        const diff = day === 0 ? -6 : 1 - day;
        const monday = new Date(d);
        monday.setDate(d.getDate() + diff);
        return monday.toISOString().split('T')[0];
    }

    const weeks = {};
    records.forEach(r => {
        const monday = getMonday(r.date);
        const dayName = new Date(r.date).toLocaleDateString('en-US', { weekday: 'long' });
        if (!weeks[monday]) weeks[monday] = {};
        if (!weeks[monday][dayName]) weeks[monday][dayName] = [];
        weeks[monday][dayName].push(r);
    });

    const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    const statusColors = { 'Present': '#166534', 'Late': '#d79b00', 'Absent': '#b91c1c' };
    const sortedWeeks = Object.keys(weeks).sort((a, b) => new Date(b) - new Date(a));

    let html = '<div style="overflow-x:auto;"><table style="border-collapse:collapse; width:100%;">';
    html += '<thead><tr style="background:#4a2c1a; color:white;"><th style="padding:8px;">Week of</th>';
    dayOrder.forEach(d => { html += `<th style="padding:8px;">${d}</th>`; });
    html += '</tr></thead><tbody>';

    sortedWeeks.forEach(monday => {
        html += `<tr><td style="padding:8px; font-weight:bold; background:#f4efe8;">${monday}</td>`;
        dayOrder.forEach(day => {
            const dayRecords = weeks[monday][day];
            if (!dayRecords) {
                html += `<td style="padding:8px; text-align:center; color:#ccc;">-</td>`;
            } else {
                const cell = dayRecords.map(r =>
                    `<span style="color:${statusColors[r.status] || '#333'}; font-weight:bold; font-size:0.85rem;">${r.session === 'Afternoon' ? 'PM' : 'AM'}: ${r.status}</span>`
                ).join('<br>');
                html += `<td style="padding:8px; text-align:center;">${cell}</td>`;
            }
        });
        html += '</tr>';
    });

    html += '</tbody></table></div>';
    return html;
}

async function loadStudentAttendance() {
    const container = document.getElementById('studentAttendance');
    if (!container) return;

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return;

    const { data: student } = await supabaseClient
        .from('students')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();

    if (!student) {
        container.innerHTML = '<p>Student record not found.</p>';
        return;
    }

    const { data, error } = await supabaseClient
        .from('attendance')
        .select('date, session, status, classes(name)')
        .eq('student_id', student.id)
        .order('date', { ascending: false })
        .limit(20);

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = '<p>No attendance records found.</p>';
        return;
    }

    let html = '<h4>My Attendance</h4>' + renderAttendanceGrid(data);
    container.innerHTML = html;
}

// ============================================================
// 11. STUDENT TIMETABLE (FIXED)
// ============================================================
// ============================================================
// Shared timetable GRID renderer — days as rows, time slots as
// columns (matching the school's actual timetable sheet format),
// instead of a flat list of individual periods.
// ============================================================
function renderTimetableGrid(entries) {
    if (!entries || entries.length === 0) {
        return '<p>No timetable entries yet.</p>';
    }

    const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

    // Distinct time slots, sorted chronologically, become the columns
    const slotMap = {};
    entries.forEach(e => {
        const key = `${e.start_time}-${e.end_time}`;
        slotMap[key] = { start: e.start_time, end: e.end_time };
    });
    const slots = Object.values(slotMap).sort((a, b) => a.start.localeCompare(b.start));

    let html = '<div style="overflow-x:auto;"><table style="border-collapse:collapse; width:100%;">';
    html += '<thead><tr style="background:#4a2c1a; color:white;"><th style="padding:8px; border:1px solid #ccc;">Time</th>';
    slots.forEach(s => {
        html += `<th style="padding:8px; border:1px solid #ccc;">${s.start.slice(0,5)} - ${s.end.slice(0,5)}</th>`;
    });
    html += '</tr></thead><tbody>';

    dayOrder.forEach(day => {
        html += `<tr><td style="padding:8px; border:1px solid #ccc; font-weight:bold; background:#f4efe8;">${day}</td>`;
        slots.forEach(s => {
            const entry = entries.find(e => e.day_of_week === day && e.start_time === s.start && e.end_time === s.end);
            html += `<td style="padding:8px; border:1px solid #ccc; text-align:center;">
                ${entry ? `<strong>${entry.subjects?.name || 'N/A'}</strong>${entry.staff?.name ? `<br><small style="color:#666;">${entry.staff.name}</small>` : ''}` : ''}
            </td>`;
        });
        html += '</tr>';
    });

    html += '</tbody></table></div>';
    return html;
}

async function loadStudentTimetable() {
    const container = document.getElementById('studentTimetable');
    if (!container) return;

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return;

    const { data: student, error } = await supabaseClient
        .from('students')
        .select('class_id, classes(name)')
        .eq('user_id', user.id)
        .maybeSingle();

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    if (!student || !student.class_id) {
        container.innerHTML = `
            <div class="glass-card" style="text-align:center;">
                <p>No timetable available yet.</p>
                <p style="font-size:0.9rem; color:#6b3a2a;">Please contact the administrator to assign you to a class.</p>
            </div>
        `;
        return;
    }

    const { data, error: timetableError } = await supabaseClient
        .from('timetable')
        .select('*, subjects(name), staff(name)')
        .eq('class_id', student.class_id)
        .order('day_of_week');

    if (timetableError) {
        container.innerHTML = `<p style="color:red;">Error: ${timetableError.message}</p>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = `
            <div class="glass-card" style="text-align:center;">
                <p>No timetable available for your class yet.</p>
                <p style="font-size:0.9rem; color:#6b3a2a;">Please contact the administrator.</p>
            </div>
        `;
        return;
    }

    let html = '<h4>My Timetable</h4>' + renderTimetableGrid(data);
    container.innerHTML = html;
}

// ============================================================
// ADMIN OVERVIEW STATS
// ============================================================
async function loadAdminOverviewStats() {
    const container = document.getElementById('adminOverviewStats');
    if (!container) return;

    const { data: users, error } = await supabaseClient.from('users').select('role');

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    const counts = { admin: 0, teacher: 0, parent: 0, student: 0 };
    (users || []).forEach(u => {
        if (counts[u.role] !== undefined) counts[u.role]++;
    });
    const total = (users || []).length;

    const stats = [
        { label: 'Total Users', value: total, icon: '👥', color: '#4a2c1a' },
        { label: 'Admins', value: counts.admin, icon: '🔑', color: '#b91c1c' },
        { label: 'Teachers', value: counts.teacher, icon: '👨‍🏫', color: '#1a3c5e' },
        { label: 'Students', value: counts.student, icon: '🎓', color: '#166534' },
        { label: 'Parents', value: counts.parent, icon: '👪', color: '#d79b00' }
    ];

    container.innerHTML = stats.map(s => `
        <div style="flex:1 1 140px; background:${s.color}; color:white; border-radius:16px; padding:1.2rem; text-align:center; box-shadow:0 4px 15px rgba(0,0,0,0.15);">
            <div style="font-size:1.8rem;">${s.icon}</div>
            <div style="font-size:2rem; font-weight:bold; margin:0.2rem 0;">${s.value}</div>
            <div style="font-size:0.85rem; opacity:0.9;">${s.label}</div>
        </div>
    `).join('');
}

// ============================================================
// WEEKLY TEST SCHEDULE (admin approves subjects per week)
// ============================================================
async function loadWeeklyScheduleClasses() {
    const select = document.getElementById('scheduleClassSelect');
    if (!select) return;
    const { data: classes } = await supabaseClient.from('classes').select('id, name').order('name');
    select.innerHTML = '<option value="">Select a class...</option>' +
        (classes || []).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
}

async function loadWeeklyScheduleForClassWeek() {
    const classId = document.getElementById('scheduleClassSelect').value;
    const weekNumber = parseInt(document.getElementById('scheduleWeekInput').value) || 1;
    const container = document.getElementById('scheduleSubjectChecklist');

    if (!classId) {
        container.innerHTML = '';
        return;
    }

    const { data: termData } = await supabaseClient
        .from('terms')
        .select('id, name')
        .eq('is_active', true)
        .limit(1);
    const term = termData?.[0] || { id: 1, name: 'Current Term' };

    const { data: subjects } = await supabaseClient
        .from('subjects')
        .select('id, name')
        .eq('class_id', classId)
        .order('name');

    if (!subjects || subjects.length === 0) {
        container.innerHTML = '<p>No subjects exist for this class yet — add some first.</p>';
        return;
    }

    const { data: approved } = await supabaseClient
        .from('weekly_test_schedule')
        .select('subject_id')
        .eq('class_id', classId)
        .eq('week_number', weekNumber)
        .eq('term_id', term.id);

    const approvedIds = new Set((approved || []).map(a => a.subject_id));

    let html = `<h4>Week ${weekNumber} — ${term.name}</h4><p style="font-size:0.85rem; color:#666;">Check every subject being tested this week for this class.</p>`;
    subjects.forEach(s => {
        html += `
            <label style="display:block; padding:0.4rem 0;">
                <input type="checkbox" id="sched_${s.id}" ${approvedIds.has(s.id) ? 'checked' : ''} style="width:18px; height:18px; margin-right:0.5rem;">
                ${s.name}
            </label>
        `;
    });
    html += `<button onclick="saveWeeklySchedule(${classId}, ${weekNumber}, ${term.id})" class="btn-primary" style="margin-top:1rem; border:none; cursor:pointer; padding:0.6rem 1.5rem;">Save Schedule</button>
        <div id="scheduleStatus" style="margin-top:0.8rem; font-weight:bold;"></div>`;
    container.innerHTML = html;

    // Stash subject list for the save function
    container.dataset.subjectIds = subjects.map(s => s.id).join(',');
}

async function saveWeeklySchedule(classId, weekNumber, termId) {
    const statusEl = document.getElementById('scheduleStatus');
    statusEl.textContent = '⏳ Saving...';
    statusEl.style.color = '#1a3c5e';

    const container = document.getElementById('scheduleSubjectChecklist');
    const subjectIds = container.dataset.subjectIds.split(',').map(Number);

    const toApprove = [];
    const toRemove = [];
    subjectIds.forEach(subjectId => {
        const checkbox = document.getElementById(`sched_${subjectId}`);
        if (checkbox?.checked) {
            toApprove.push(subjectId);
        } else {
            toRemove.push(subjectId);
        }
    });

    if (toApprove.length > 0) {
        const { error: insertError } = await supabaseClient
            .from('weekly_test_schedule')
            .upsert(
                toApprove.map(subjectId => ({ term_id: termId, week_number: weekNumber, subject_id: subjectId, class_id: classId })),
                { onConflict: 'term_id, week_number, subject_id, class_id' }
            );
        if (insertError) {
            statusEl.textContent = '❌ Error: ' + insertError.message;
            statusEl.style.color = '#b91c1c';
            return;
        }
    }

    if (toRemove.length > 0) {
        const { error: deleteError } = await supabaseClient
            .from('weekly_test_schedule')
            .delete()
            .eq('term_id', termId)
            .eq('week_number', weekNumber)
            .eq('class_id', classId)
            .in('subject_id', toRemove);
        if (deleteError) {
            statusEl.textContent = '❌ Error: ' + deleteError.message;
            statusEl.style.color = '#b91c1c';
            return;
        }
    }

    statusEl.textContent = '✅ Schedule saved! Teachers can now only enter scores for the checked subjects this week.';
    statusEl.style.color = '#166534';
}


const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

async function loadTimetableManagerClasses() {
    const select = document.getElementById('timetableClassSelect');
    if (!select) return;

    const { data: classes } = await supabaseClient.from('classes').select('id, name').order('name');
    select.innerHTML = '<option value="">Select a class...</option>' +
        (classes || []).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
}

let selectedTimetableClassId = null;

async function loadTimetableForClass(classId) {
    selectedTimetableClassId = classId ? parseInt(classId) : null;
    const container = document.getElementById('timetableEntryList');
    const formContainer = document.getElementById('timetableFormContainer');

    if (!selectedTimetableClassId) {
        container.innerHTML = '';
        formContainer.style.display = 'none';
        return;
    }

    formContainer.style.display = 'block';
    container.innerHTML = '<p>Loading timetable...</p>';

    // Subjects are tied to a class, so refresh the Add Entry form's subject list too
    const { data: subjects } = await supabaseClient
        .from('subjects')
        .select('id, name')
        .eq('class_id', selectedTimetableClassId)
        .order('name');
    const subjectSelect = document.getElementById('timetableSubjectSelect');
    if (subjectSelect) {
        subjectSelect.innerHTML = '<option value="">Select Subject</option>' +
            (subjects || []).map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    }

    const { data: teachers } = await supabaseClient.from('staff').select('id, name').order('name');
    const teacherSelect = document.getElementById('timetableTeacherSelect');
    if (teacherSelect) {
        teacherSelect.innerHTML = '<option value="">Select Teacher</option>' +
            (teachers || []).map(t => `<option value="${t.id}">${t.name}</option>`).join('');
    }

    const { data, error } = await supabaseClient
        .from('timetable')
        .select('*, subjects(name), staff(name)')
        .eq('class_id', selectedTimetableClassId);

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = '<p>No timetable entries for this class yet.</p>';
        return;
    }

    const sorted = [...data].sort((a, b) => {
        const dayDiff = DAY_ORDER.indexOf(a.day_of_week) - DAY_ORDER.indexOf(b.day_of_week);
        if (dayDiff !== 0) return dayDiff;
        return a.start_time.localeCompare(b.start_time);
    });

    let html = `<h5>Preview</h5>${renderTimetableGrid(sorted)}<h5 style="margin-top:1.5rem;">Manage Entries</h5>`;
    html += '<div style="overflow-x:auto;"><table><thead><tr style="background:#4a2c1a; color:white;"><th style="padding:8px;">Day</th><th style="padding:8px;">Time</th><th style="padding:8px;">Subject</th><th style="padding:8px;">Teacher</th><th style="padding:8px;"></th></tr></thead><tbody>';
    sorted.forEach(t => {
        html += `
            <tr style="border-bottom:1px solid #eee;">
                <td style="padding:8px;">${t.day_of_week}</td>
                <td style="padding:8px;">${t.start_time.slice(0,5)} - ${t.end_time.slice(0,5)}</td>
                <td style="padding:8px;">${t.subjects?.name || 'N/A'}</td>
                <td style="padding:8px;">${t.staff?.name || 'N/A'}</td>
                <td style="padding:8px;"><button onclick="deleteTimetableEntry(${t.id})" style="background:#b91c1c; color:white; border:none; border-radius:4px; padding:0.2rem 0.8rem; cursor:pointer;">Delete</button></td>
            </tr>
        `;
    });
    html += '</tbody></table></div>';
    container.innerHTML = html;
}

async function saveTimetableEntry() {
    if (!selectedTimetableClassId) {
        alert('Please select a class first.');
        return;
    }

    const subjectId = document.getElementById('timetableSubjectSelect').value;
    const teacherId = document.getElementById('timetableTeacherSelect').value;
    const dayOfWeek = document.getElementById('timetableDaySelect').value;
    const startTime = document.getElementById('timetableStartTime').value;
    const endTime = document.getElementById('timetableEndTime').value;

    if (!subjectId || !dayOfWeek || !startTime || !endTime) {
        alert('Please fill in subject, day, start time, and end time.');
        return;
    }

    if (startTime >= endTime) {
        alert('End time must be after start time.');
        return;
    }

    const { error } = await supabaseClient
        .from('timetable')
        .insert([{
            class_id: selectedTimetableClassId,
            subject_id: subjectId,
            teacher_id: teacherId || null,
            day_of_week: dayOfWeek,
            start_time: startTime,
            end_time: endTime
        }]);

    if (error) {
        alert('Error saving timetable entry: ' + error.message);
        return;
    }

    document.getElementById('timetableStartTime').value = '';
    document.getElementById('timetableEndTime').value = '';
    loadTimetableForClass(selectedTimetableClassId);
}

async function deleteTimetableEntry(id) {
    if (!confirm('Remove this timetable entry?')) return;
    const { error } = await supabaseClient.from('timetable').delete().eq('id', id);
    if (error) {
        alert('Error: ' + error.message);
        return;
    }
    loadTimetableForClass(selectedTimetableClassId);
}

async function loadParentChildren() {
    const container = document.getElementById('childrenContainer');
    if (!container) return;

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
        container.innerHTML = '<p>Please log in.</p>';
        return;
    }

    const { data, error } = await supabaseClient
        .from('parent_children')
        .select('*, students(id, full_name, admission_number, class_id, classes(name))')
        .eq('parent_id', user.id);

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = `
            <div class="glass-card" style="text-align:center;">
                <h3>No Children Linked</h3>
                <p>Please contact the school to link your children to your account.</p>
            </div>
        `;
        return;
    }

    let html = '<h3>📚 My Children</h3><div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:1.5rem; margin-top:1rem;">';

    for (const child of data) {
        const student = child.students;
        const className = student.classes?.name || 'Not assigned';

        html += `
            <div class="glass-card">
                <h3>${student.full_name}</h3>
                <p><strong>Class:</strong> ${className}</p>
                <p><strong>Admission:</strong> ${student.admission_number}</p>
                <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:1rem;">
                    <button onclick="viewChildReportCard(${student.id}, '${student.full_name.replace(/'/g, "\\'")}')" class="btn-primary" style="font-size:0.8rem; padding:0.4rem 1rem; border:none; cursor:pointer;">
                        📄 Report Card
                    </button>
                    <button onclick="loadParentChildAIAnalytics(${student.id})" class="btn-primary" style="font-size:0.8rem; padding:0.4rem 1rem; border:none; cursor:pointer;">
                        🤖 AI Analytics
                    </button>
                    <button onclick="viewChildAttendance(${student.id}, '${student.full_name.replace(/'/g, "\\'")}')" class="btn-secondary" style="font-size:0.8rem; padding:0.4rem 1rem; border:none; cursor:pointer;">
                        📋 Attendance
                    </button>
                </div>
            </div>
        `;
    }

    html += '</div>';
    container.innerHTML = html;
}

async function viewChildReportCard(studentId, childName) {
    const container = document.getElementById('childReportCardContainer');
    if (!container) return;

    container.innerHTML = `<div class="glass-card"><p>Loading ${childName}'s report card...</p></div>`;
    container.scrollIntoView({ behavior: 'smooth' });

    const { data: studentData } = await supabaseClient
        .from('students')
        .select('id, full_name, admission_number, class_id, classes(name)')
        .eq('id', studentId)
        .maybeSingle();

    if (!studentData) {
        container.innerHTML = `<div class="glass-card"><p>Could not load this student's record.</p></div>`;
        return;
    }

    const { data: termData } = await supabaseClient
        .from('terms')
        .select('id, name, next_term_begins, results_published')
        .eq('is_active', true)
        .limit(1);
    const term = termData?.[0] || { id: 1, name: 'Current Term' };

    if (!term.results_published) {
        container.innerHTML = `
            <div class="glass-card" style="text-align:center;">
                <h3>Results Not Yet Published</h3>
                <p>${childName}'s report card for ${term.name} will appear here once the school publishes results.</p>
            </div>
        `;
        return;
    }

    const { data: weeklyData } = await supabaseClient
        .from('weekly_test_results')
        .select('subject_id, week_number, score, subjects(name)')
        .eq('student_id', studentId)
        .eq('term_id', term.id);

    const { data: examData } = await supabaseClient
        .from('exam_scores')
        .select('subject_id, exam_score, teacher_comment, subjects(name)')
        .eq('student_id', studentId)
        .eq('term_id', term.id);

    const { data: characterData } = await supabaseClient
        .from('character_assessment')
        .select('*')
        .eq('student_id', studentId)
        .eq('term_id', term.id)
        .maybeSingle();

    const positionData = studentData.class_id
        ? await computeReportCardPositions(studentId, studentData.class_id, term.id)
        : null;
    const signatureUrl = await getPrincipalSignatureUrl();

    const cardHtml = renderReportCardHTML(studentData, weeklyData, examData, characterData, term.name, positionData, term, signatureUrl);

    container.innerHTML = `
        ${cardHtml}
        <div style="margin-top: 1.5rem; text-align: center;">
            <button onclick="window.print()" class="btn-primary" style="border:none; cursor:pointer; padding:0.8rem 2rem;">
                Print / Download as PDF
            </button>
            <button onclick="document.getElementById('childReportCardContainer').innerHTML=''" class="btn-secondary" style="border:none; cursor:pointer; padding:0.8rem 2rem; margin-left:0.5rem;">
                ✖️ Close
            </button>
        </div>
    `;
}

async function viewChildAttendance(studentId, childName) {
    const container = document.getElementById('childReportCardContainer');
    if (!container) return;

    container.innerHTML = `<div class="glass-card"><p>⏳ Loading ${childName}'s attendance...</p></div>`;
    container.scrollIntoView({ behavior: 'smooth' });

    const { data, error } = await supabaseClient
        .from('attendance')
        .select('date, session, status, classes(name)')
        .eq('student_id', studentId)
        .order('date', { ascending: false })
        .limit(30);

    if (error) {
        container.innerHTML = `<div class="glass-card"><p style="color:red;">Error: ${error.message}</p></div>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = `<div class="glass-card"><p>No attendance records found for ${childName} yet.</p></div>`;
        return;
    }

    container.innerHTML = `
        <div class="glass-card" style="max-width:700px; margin:0 auto;">
            <h3 style="color:#4a2c1a;">${childName}'s Attendance</h3>
            ${renderAttendanceGrid(data)}
            <div style="text-align:center; margin-top:1rem;">
                <button onclick="document.getElementById('childReportCardContainer').innerHTML=''" class="btn-secondary" style="border:none; cursor:pointer; padding:0.6rem 1.5rem;">
                    Close
                </button>
            </div>
        </div>
    `;
}

// ============================================================
// 13. PARENT-CHILD LINKING (ADMIN)
// ============================================================

let allParentLinksCache = [];

async function loadParentLinks() {
    const container = document.getElementById('parentLinkList');
    if (!container) return;

    const { data, error } = await supabaseClient
        .from('parent_children')
        .select('*, students(full_name, admission_number, classes(name)), users(email)')
        .order('id');

    if (error) {
        container.innerHTML = `<p style="color:red;">Error: ${error.message}</p>`;
        return;
    }

    allParentLinksCache = data || [];
    renderParentLinkList(allParentLinksCache);
}

function renderParentLinkList(links) {
    const container = document.getElementById('parentLinkList');
    if (!container) return;

    if (!links || links.length === 0) {
        container.innerHTML = '<p>No parent-child links yet.</p>';
        return;
    }

    // Same grouping approach as the student list — this grows 1-for-1 with
    // your student count, so it needs the same scalability treatment.
    const grouped = {};
    links.forEach(link => {
        const className = link.students?.classes?.name || 'Not Assigned';
        if (!grouped[className]) grouped[className] = [];
        grouped[className].push(link);
    });

    const sortedClassNames = Object.keys(grouped).sort();

    let html = '';
    sortedClassNames.forEach(className => {
        const list = grouped[className];
        html += `
            <details style="margin-bottom:0.8rem; border:1px solid #eee; border-radius:8px; padding:0.5rem 1rem;">
                <summary style="cursor:pointer; font-weight:bold; color:#4a2c1a; padding:0.3rem 0;">
                    ${className} (${list.length} link${list.length === 1 ? '' : 's'})
                </summary>
                <ul style="list-style:none; padding:0; margin-top:0.5rem;">
                    ${list.map(link => `
                        <li style="padding:0.5rem 0; border-bottom:1px solid #eee;">
                            <strong>${link.students?.full_name || 'Unknown'}</strong>
                            (${link.students?.admission_number || 'N/A'})<br>
                            Parent: ${link.users?.email || 'Unknown email'}
                            <button onclick="deleteParentLink(${link.id})" style="float:right; background:#b91c1c; color:white; border:none; border-radius:4px; padding:0.2rem 0.8rem; cursor:pointer;">Remove</button>
                        </li>
                    `).join('')}
                </ul>
            </details>
        `;
    });

    container.innerHTML = html;
}

function filterParentLinkList() {
    const query = document.getElementById('parentLinkSearchInput').value.toLowerCase().trim();
    if (!query) {
        renderParentLinkList(allParentLinksCache);
        return;
    }
    const filtered = allParentLinksCache.filter(link =>
        (link.students?.full_name || '').toLowerCase().includes(query) ||
        (link.students?.admission_number || '').toLowerCase().includes(query) ||
        (link.users?.email || '').toLowerCase().includes(query)
    );
    renderParentLinkList(filtered);
}

function showAddParentLinkForm() {
    const container = document.getElementById('parentLinkFormContainer');
    if (container) {
        container.style.display = container.style.display === 'none' ? 'block' : 'none';
        loadParentsDropdown();
        loadStudentsDropdown();
    }
}

async function loadParentsDropdown() {
    const select = document.getElementById('parentSelect');
    if (!select) return;

    const { data, error } = await supabaseClient
        .from('users')
        .select('id, email')
        .eq('role', 'parent');

    if (error) return;

    select.innerHTML = '<option value="">Select Parent</option>';
    data.forEach(p => {
        select.innerHTML += `<option value="${p.id}">${p.email}</option>`;
    });
}

async function loadStudentsDropdown() {
    const select = document.getElementById('childSelect');
    if (!select) return;

    const { data, error } = await supabaseClient
        .from('students')
        .select('id, full_name, admission_number')
        .order('full_name');

    if (error) return;

    select.innerHTML = '<option value="">Select Child</option>';
    data.forEach(s => {
        select.innerHTML += `<option value="${s.id}">${s.full_name} (${s.admission_number})</option>`;
    });
}

async function linkParentToChild() {
    const parentId = document.getElementById('parentSelect').value;
    const studentId = document.getElementById('childSelect').value;

    if (!parentId || !studentId) {
        alert('Please select both parent and child.');
        return;
    }

    const { error } = await supabaseClient
        .from('parent_children')
        .insert([{ parent_id: parentId, student_id: studentId }]);

    if (error) {
        alert('Error linking parent to child: ' + error.message);
        return;
    }

    alert('✅ Parent linked to child successfully!');
    document.getElementById('parentLinkFormContainer').style.display = 'none';
    loadParentLinks();
}

async function deleteParentLink(id) {
    if (!confirm('Remove this link?')) return;
    const { error } = await supabaseClient
        .from('parent_children')
        .delete()
        .eq('id', id);
    if (error) {
        alert('Error: ' + error.message);
        return;
    }
    alert('✅ Link removed.');
    loadParentLinks();
}

// ============================================================
// 14. PUBLIC FUNCTIONS
// ============================================================

async function loadPublicNews() {
    const container = document.getElementById('newsContainer');
    if (!container) return;

    const { data, error } = await supabaseClient
        .from('news')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        container.innerHTML = '<p>Error loading news.</p>';
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = '<p>No news yet. Check back later!</p>';
        return;
    }

    let html = '';
    data.forEach(n => {
        const date = new Date(n.created_at).toLocaleDateString();
        html += `
            <div class="glass-card" style="margin-bottom:1.5rem;">
                <h3>${n.title}</h3>
                <p>${n.content}</p>
                <small style="color:#999;">Posted: ${date}</small>
            </div>
        `;
    });
    container.innerHTML = html;
}

async function loadPublicStaff() {
    const container = document.getElementById('staffContainer');
    if (!container) return;

    const { data, error } = await supabaseClient
        .from('staff')
        .select('*')
        .order('name');

    if (error) {
        container.innerHTML = '<p>Error loading staff.</p>';
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = '<p>No staff members found.</p>';
        return;
    }

    let html = '<div class="staff-grid">';
    data.forEach(staff => {
        const photo = staff.photo_url || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(staff.name) + '&background=d4a373&color=fff&size=120';
        html += `
            <div class="glass-card staff-card">
                <img src="${photo}" alt="${staff.name}">
                <h3>${staff.name}</h3>
                <p class="qualification">${staff.qualification || ''}</p>
                <p class="subject">${staff.subject ? '📖 ' + staff.subject : ''}</p>
                <p class="experience">${staff.experience_years ? '⭐ ' + staff.experience_years + ' Years' : ''}</p>
                ${staff.bio ? `<p style="font-size:0.85rem; color:#666; font-style:italic;">"${staff.bio}"</p>` : ''}
            </div>
        `;
    });
    html += '</div>';
    container.innerHTML = html;
}

// ============================================================
// 15. DOWNLOAD FUNCTIONS
// ============================================================

async function downloadAllReportCards(termId, classId, studentIds) {
    const statusEl = document.getElementById('downloadStatus');
    if (!statusEl) {
        alert('Download status element not found.');
        return;
    }

    statusEl.textContent = '⏳ Generating report cards...';
    statusEl.style.color = '#1a3c5e';

    const { data: termRow } = await supabaseClient
        .from('terms')
        .select('id, name, next_term_begins')
        .eq('id', termId)
        .maybeSingle();
    const termName = termRow?.name || `Term ${termId}`;

    // Covers every student, whether they self-registered or were added by admin —
    // there's only one students table now, so nobody gets left out. Can be
    // narrowed to a single class, or one/several specific students, via the
    // filters below. Admin's own downloads always work regardless of whether
    // results have been "published" yet — that gate only applies to
    // students/parents viewing their own report cards.
    let studentQuery = supabaseClient
        .from('students')
        .select('id, full_name, admission_number, class_id, classes(name)');
    if (studentIds && studentIds.length > 0) studentQuery = studentQuery.in('id', studentIds);
    else if (classId) studentQuery = studentQuery.eq('class_id', classId);

    const { data: students, error } = await studentQuery;

    if (error) {
        statusEl.textContent = '❌ Error: ' + error.message;
        statusEl.style.color = '#b91c1c';
        return;
    }

    if (!students || students.length === 0) {
        statusEl.textContent = '⚠️ No students found for that selection.';
        statusEl.style.color = '#d79b00';
        return;
    }

    const { data: allWeekly } = await supabaseClient
        .from('weekly_test_results')
        .select('student_id, subject_id, week_number, score, subjects(name)')
        .eq('term_id', termId);

    const { data: allExams } = await supabaseClient
        .from('exam_scores')
        .select('student_id, subject_id, exam_score, teacher_comment')
        .eq('term_id', termId);

    const { data: allCharacter } = await supabaseClient
        .from('character_assessment')
        .select('*')
        .eq('term_id', termId);

    const signatureUrl = await getPrincipalSignatureUrl();

    let allReportCards = '';

    for (const student of students) {
        const studentWeekly = (allWeekly || []).filter(w => w.student_id === student.id);
        const studentExams = (allExams || []).filter(e => e.student_id === student.id);
        const studentCharacter = (allCharacter || []).find(c => c.student_id === student.id) || null;
        const positionData = student.class_id
            ? await computeReportCardPositions(student.id, student.class_id, termId)
            : null;

        const cardHtml = renderReportCardHTML(student, studentWeekly, studentExams, studentCharacter, termName, positionData, termRow, signatureUrl);

        allReportCards += `<div style="page-break-after:always;">${cardHtml}</div>`;
    }

    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
        <html>
        <head>
            <title>All Report Cards</title>
            <style>
                body { font-family: Arial, sans-serif; }
                table { width: 100%; border-collapse: collapse; }
                th { background: #4a2c1a; color: white; padding: 8px; text-align: left; }
                td { padding: 8px; border-bottom: 1px solid #ddd; }
                hr { border: 1px solid #d4a373; margin: 1rem 0; }
                @media print { body { margin: 0; padding: 20px; } }
            </style>
        </head>
        <body>
            ${allReportCards}
        </body>
        </html>
    `);
    printWindow.document.close();

    setTimeout(() => { printWindow.print(); }, 500);

    statusEl.textContent = '✅ Report cards generated successfully!';
    statusEl.style.color = '#166534';
}

// ============================================================
// CUMULATIVE GPA / BEST GRADUATING STUDENTS
// Ranks students by their average Total (CA+Exam) across EVERY
// subject and EVERY term ever recorded for them — a running
// academic history, useful for picking the best overall student
// when a class graduates (not just their best single term).
// ============================================================
async function loadBestGraduatingStudents(classId) {
    const container = document.getElementById('cgpaResultsContainer');
    if (!container) return;
    container.innerHTML = '<p>⏳ Calculating rankings across all terms on record...</p>';

    let studentQuery = supabaseClient.from('students').select('id, full_name, admission_number, classes(name)');
    if (classId) studentQuery = studentQuery.eq('class_id', classId);
    const { data: students, error: studentsError } = await studentQuery;

    if (studentsError) {
        container.innerHTML = `<p style="color:red;">Error: ${studentsError.message}</p>`;
        return;
    }
    if (!students || students.length === 0) {
        container.innerHTML = '<p>No students found.</p>';
        return;
    }

    const studentIds = students.map(s => s.id);

    const { data: allWeekly } = await supabaseClient
        .from('weekly_test_results')
        .select('student_id, subject_id, term_id, score')
        .in('student_id', studentIds);

    const { data: allExams } = await supabaseClient
        .from('exam_scores')
        .select('student_id, subject_id, term_id, exam_score')
        .in('student_id', studentIds);

    // Group weekly scores by student+subject+term so CA can be normalized
    // by however many weeks were actually tested, not just summed and
    // capped — the same early-term-capping bug fixed everywhere else.
    const weeklyGroups = {};
    (allWeekly || []).forEach(w => {
        const key = `${w.student_id}|${w.subject_id}|${w.term_id}`;
        if (!weeklyGroups[key]) weeklyGroups[key] = [];
        weeklyGroups[key].push(w.score);
    });

    const examMap = {};
    (allExams || []).forEach(e => {
        const key = `${e.student_id}|${e.subject_id}|${e.term_id}`;
        examMap[key] = e.exam_score;
    });

    const allKeys = new Set([...Object.keys(weeklyGroups), ...Object.keys(examMap)]);
    const studentTotals = {};

    allKeys.forEach(key => {
        const studentId = parseInt(key.split('|')[0]);
        const ca = calculateCA(weeklyGroups[key] || []);
        const exam = Math.min(75, examMap[key] || 0);
        const total = ca + exam;
        if (!studentTotals[studentId]) studentTotals[studentId] = { sum: 0, count: 0 };
        studentTotals[studentId].sum += total;
        studentTotals[studentId].count += 1;
    });

    const ranked = students
        .map(s => {
            const t = studentTotals[s.id] || { sum: 0, count: 0 };
            return { ...s, average: t.count > 0 ? t.sum / t.count : 0, recordsCount: t.count };
        })
        .filter(s => s.recordsCount > 0)
        .sort((a, b) => b.average - a.average);

    if (ranked.length === 0) {
        container.innerHTML = '<p>No academic records found yet for these students.</p>';
        return;
    }

    let rows = '';
    ranked.forEach((s, index) => {
        const position = index + 1;
        rows += `
            <tr style="border-bottom:1px solid #ddd;">
                <td style="padding:8px; font-weight:bold;">${getOrdinal(position)}</td>
                <td style="padding:8px;"><strong>${s.full_name}</strong></td>
                <td style="padding:8px;">${s.admission_number}</td>
                <td style="padding:8px;">${s.classes?.name || 'N/A'}</td>
                <td style="padding:8px; font-weight:bold;">${Math.round(s.average)}%</td>
                <td style="padding:8px;">${getGrade(s.average)}</td>
                <td style="padding:8px; font-size:0.85rem; color:#666;">${s.recordsCount}</td>
            </tr>
        `;
    });

    container.innerHTML = '<p style="color:#166534; font-weight:bold;">✅ Ranking generated — opening downloadable sheet in a new tab...</p>';

    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
        <html>
        <head>
            <title>Best Graduating Students</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 30px; }
                table { border-collapse: collapse; width: 100%; }
                @media print { body { padding: 0; } }
            </style>
        </head>
        <body>
            <h2 style="text-align:center; color:#4a2c1a;">Wonderhills College</h2>
            <p style="text-align:center;">Best Graduating Students${classId ? '' : ' — All Classes'}</p>
            <hr>
            <div style="overflow-x:auto;">
                <table>
                    <thead>
                        <tr style="background:#4a2c1a; color:white;">
                            <th style="padding:8px;">Position</th>
                            <th style="padding:8px;">Student</th>
                            <th style="padding:8px;">Admission</th>
                            <th style="padding:8px;">Class</th>
                            <th style="padding:8px;">Overall Percentage</th>
                            <th style="padding:8px;">Grade</th>
                            <th style="padding:8px;">Subject-Terms Recorded</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <p style="font-size:0.8rem; color:#6b3a2a; margin-top:20px;">
                * "Overall Percentage" is each student's average Total (CA+Exam) across every subject and every term recorded — their whole academic history in the system, not just one term. "Subject-Terms Recorded" shows how many subject/term combinations that average is based on.
            </p>
            <p style="text-align:center; margin-top:20px;">© 2026 Wonderhills College</p>
            <div class="no-print" style="text-align:center; margin-top:20px;">
                <button onclick="window.print()" style="padding:10px 30px; background:#1a3c5e; color:white; border:none; border-radius:6px; cursor:pointer;">Print / Save as PDF</button>
            </div>
        </body>
        </html>
    `);
    printWindow.document.close();
}

async function downloadAllCumulativeScores(termId, classId, studentIds) {
    const statusEl = document.getElementById('downloadStatus');
    if (!statusEl) {
        alert('Download status element not found.');
        return;
    }

    statusEl.textContent = '⏳ Generating cumulative scores...';
    statusEl.style.color = '#1a3c5e';

    const { data: termRow } = await supabaseClient
        .from('terms')
        .select('name, weeks_count')
        .eq('id', termId)
        .maybeSingle();
    const termName = termRow?.name || `Term ${termId}`;
    const weeksCount = termRow?.weeks_count || 8;

    let matchingStudentIds = null;
    if (studentIds && studentIds.length > 0) {
        matchingStudentIds = studentIds;
    } else if (classId) {
        const { data: classStudents } = await supabaseClient
            .from('students')
            .select('id')
            .eq('class_id', classId);
        matchingStudentIds = (classStudents || []).map(s => s.id);
    }

    let resultsQuery = supabaseClient
        .from('weekly_test_results')
        .select(`
            student_id,
            subject_id,
            score,
            students (full_name, admission_number, class_id, classes(name))
        `)
        .eq('term_id', termId);
    if (matchingStudentIds) resultsQuery = resultsQuery.in('student_id', matchingStudentIds);

    const { data: results, error } = await resultsQuery;

    if (error) {
        statusEl.textContent = '❌ Error: ' + error.message;
        statusEl.style.color = '#b91c1c';
        return;
    }

    if (!results || results.length === 0) {
        statusEl.textContent = '⚠️ No weekly test scores recorded for this term yet.';
        statusEl.style.color = '#d79b00';
        return;
    }

    const studentMap = {};
    results.forEach(r => {
        const studentId = r.student_id;
        if (!studentMap[studentId]) {
            studentMap[studentId] = {
                name: r.students?.full_name || 'Unknown',
                admission: r.students?.admission_number || 'N/A',
                className: r.students?.classes?.name || 'Not Assigned',
                subjectScores: {} // subject_id -> [scores]
            };
        }
        if (!studentMap[studentId].subjectScores[r.subject_id]) {
            studentMap[studentId].subjectScores[r.subject_id] = [];
        }
        studentMap[studentId].subjectScores[r.subject_id].push(r.score);
    });

    // Overall CA Avg per student: each subject's CA computed with the shared,
    // correctly-normalized formula, then averaged across their subjects.
    const studentList = Object.values(studentMap).map(s => {
        const subjectCAs = Object.values(s.subjectScores).map(scores => calculateCA(scores));
        const overallCA = subjectCAs.length > 0
            ? Math.round(subjectCAs.reduce((sum, v) => sum + v, 0) / subjectCAs.length)
            : 0;
        return { ...s, overallCA };
    });

    // Grouped by class, as its own printed section per class, with each
    // class's own ranking — not one blended list across the whole school.
    const byClass = {};
    studentList.forEach(s => {
        if (!byClass[s.className]) byClass[s.className] = [];
        byClass[s.className].push(s);
    });

    let classSections = '';
    Object.keys(byClass).sort().forEach(className => {
        const classStudents = byClass[className].sort((a, b) => b.overallCA - a.overallCA);
        classSections += `
            <div style="page-break-after:always;">
                <h3 style="color:#4a2c1a;">${className}</h3>
                <table style="width:100%; border-collapse:collapse;">
                    <thead>
                        <tr style="background:#4a2c1a; color:white;">
                            <th style="padding:8px;">Position</th>
                            <th style="padding:8px;">Student</th>
                            <th style="padding:8px;">Admission</th>
                            <th style="padding:8px;">Overall CA (25)</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${classStudents.map((s, i) => `
                            <tr style="border-bottom:1px solid #ddd;">
                                <td style="padding:8px;">${getOrdinal(i + 1)}</td>
                                <td style="padding:8px;"><strong>${s.name}</strong></td>
                                <td style="padding:8px;">${s.admission}</td>
                                <td style="padding:8px; font-weight:bold;">${s.overallCA}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    });

    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
        <html>
        <head>
            <title>Cumulative Scores</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 40px; }
                table { width: 100%; border-collapse: collapse; }
                th { background: #4a2c1a; color: white; padding: 8px; text-align: left; }
                td { padding: 8px; border-bottom: 1px solid #ddd; }
                hr { border: 1px solid #d4a373; margin: 1rem 0; }
                @media print { body { padding: 0; } }
            </style>
        </head>
        <body>
            <h2 style="text-align:center; color:#4a2c1a;">Wonderhills College</h2>
            <p style="text-align:center;">Cumulative Test Scores — ${termName} (compiled across ${weeksCount} week(s))</p>
            <hr>
            ${classSections}
            <p style="text-align:center; margin-top:20px;">© 2026 Wonderhills College</p>
            <div class="no-print" style="text-align:center; margin-top:20px;">
                <button onclick="window.print()" style="padding:10px 30px; background:#1a3c5e; color:white; border:none; border-radius:6px; cursor:pointer;">Print / Save as PDF</button>
            </div>
        </body>
        </html>
    `);
    printWindow.document.close();

    statusEl.textContent = '✅ Cumulative scores opened in a new tab.';
    statusEl.style.color = '#166534';
}

// Special top-5 position labels used ONLY for weekly test rankings, combined
// across all Junior (JSS1-3) or Senior (SS1-3) classes. Position 6 onward
// uses standard ordinals (6th, 7th, ...) in both groups.
function getWeeklyGroupLabel(position, section) {
    const juniorTop5 = { 1: 'M1', 2: 'R2', 3: 'E3', 4: 'A4', 5: 'B5' };
    const seniorTop5 = { 1: 'R1', 2: 'J2', 3: 'S3', 4: 'R4', 5: 'Z5' };
    const map = section === 'Junior' ? juniorTop5 : seniorTop5;
    return map[position] || getOrdinal(position);
}

async function downloadWeeklyTestSheet(weekNumber, termId, classId, studentIds) {
    const statusEl = document.getElementById('downloadStatus');
    if (!statusEl) {
        alert('Download status element not found.');
        return;
    }

    statusEl.textContent = '⏳ Generating weekly test sheet...';
    statusEl.style.color = '#1a3c5e';

    const { data: termRow } = await supabaseClient
        .from('terms')
        .select('name')
        .eq('id', termId)
        .maybeSingle();
    const termName = termRow?.name || `Term ${termId}`;

    let matchingStudentIds = null;
    if (studentIds && studentIds.length > 0) {
        matchingStudentIds = studentIds;
    } else if (classId) {
        const { data: classStudents } = await supabaseClient
            .from('students')
            .select('id')
            .eq('class_id', classId);
        matchingStudentIds = (classStudents || []).map(s => s.id);
    }

    // No subject breakdown here on purpose — just each student's total and
    // percentage for the week, exactly as requested.
    let resultsQuery = supabaseClient
        .from('weekly_test_results')
        .select(`
            student_id,
            score,
            students (full_name, admission_number, class_id, classes(name, section))
        `)
        .eq('week_number', weekNumber)
        .eq('term_id', termId);
    if (matchingStudentIds) resultsQuery = resultsQuery.in('student_id', matchingStudentIds);

    const { data: results, error } = await resultsQuery;

    if (error) {
        statusEl.textContent = '❌ Error: ' + error.message;
        statusEl.style.color = '#b91c1c';
        return;
    }

    if (!results || results.length === 0) {
        statusEl.textContent = '⚠️ No scores recorded for that week.';
        statusEl.style.color = '#d79b00';
        return;
    }

    const studentMap = {};
    results.forEach(r => {
        const studentId = r.student_id;
        if (!studentMap[studentId]) {
            studentMap[studentId] = {
                name: r.students?.full_name || 'Unknown',
                admission: r.students?.admission_number || 'N/A',
                className: r.students?.classes?.name || 'N/A',
                classId: r.students?.class_id,
                section: r.students?.classes?.section || 'Junior',
                scores: []
            };
        }
        studentMap[studentId].scores.push(r.score);
    });

    const studentList = Object.values(studentMap).map(s => {
        const total = s.scores.reduce((sum, v) => sum + v, 0);
        const percentage = s.scores.length > 0 ? Math.round(total / s.scores.length) : 0;
        return { ...s, total: Math.round(total), percentage };
    });

    // Position in Class: standard ranking within the student's own class only
    const byClass = {};
    studentList.forEach(s => {
        if (!byClass[s.classId]) byClass[s.classId] = [];
        byClass[s.classId].push(s);
    });
    Object.values(byClass).forEach(list => {
        list.sort((a, b) => b.percentage - a.percentage);
        list.forEach((s, i) => { s.positionInClass = i + 1; });
    });

    // Position in Junior/Senior Secondary School: ranked across ALL classes
    // in that section combined, using the special top-5 labels.
    const junior = studentList.filter(s => s.section === 'Junior').sort((a, b) => b.percentage - a.percentage);
    const senior = studentList.filter(s => s.section === 'Senior').sort((a, b) => b.percentage - a.percentage);
    junior.forEach((s, i) => { s.groupPosition = i + 1; });
    senior.forEach((s, i) => { s.groupPosition = i + 1; });

    function renderSection(title, list, section) {
        if (list.length === 0) return '';
        const groupLabel = section === 'Junior' ? 'Position in Junior Secondary School' : 'Position in Senior Secondary School';
        return `
            <div style="page-break-after:always;">
                <h3 style="color:#4a2c1a;">${title}</h3>
                <table style="width:100%; border-collapse:collapse;">
                    <thead>
                        <tr style="background:#4a2c1a; color:white;">
                            <th style="padding:8px;">Student</th>
                            <th style="padding:8px;">Class</th>
                            <th style="padding:8px;">Total</th>
                            <th style="padding:8px;">Percentage</th>
                            <th style="padding:8px;">Position in Class</th>
                            <th style="padding:8px;">${groupLabel}</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${list.map(s => `
                            <tr style="border-bottom:1px solid #ddd;">
                                <td style="padding:8px;"><strong>${s.name}</strong></td>
                                <td style="padding:8px;">${s.className}</td>
                                <td style="padding:8px;">${s.total}</td>
                                <td style="padding:8px;">${s.percentage}%</td>
                                <td style="padding:8px;">${getOrdinal(s.positionInClass)}</td>
                                <td style="padding:8px; font-weight:bold;">${getWeeklyGroupLabel(s.groupPosition, section)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
        <html>
        <head>
            <title>Weekly Test Sheet - Week ${weekNumber}</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 40px; }
                table { width: 100%; border-collapse: collapse; }
                th { background: #4a2c1a; color: white; padding: 8px; text-align: left; }
                td { padding: 8px; border-bottom: 1px solid #ddd; }
                hr { border: 1px solid #d4a373; margin: 1rem 0; }
                @media print { body { padding: 0; } }
            </style>
        </head>
        <body>
            <h2 style="text-align:center; color:#4a2c1a;">Wonderhills College</h2>
            <p style="text-align:center;">Weekly Test Result Sheet — Week ${weekNumber} | ${termName}</p>
            <hr>
            ${renderSection('Junior Secondary School', junior, 'Junior')}
            ${renderSection('Senior Secondary School', senior, 'Senior')}
            <p style="text-align:center; margin-top:20px;">© 2026 Wonderhills College</p>
            <div class="no-print" style="text-align:center; margin-top:20px;">
                <button onclick="window.print()" style="padding:10px 30px; background:#1a3c5e; color:white; border:none; border-radius:6px; cursor:pointer;">Print / Save as PDF</button>
            </div>
        </body>
        </html>
    `);
    printWindow.document.close();

    statusEl.textContent = '✅ Weekly test sheet opened in a new tab.';
    statusEl.style.color = '#166534';
}

// ============================================================
// 16. EMAIL FUNCTIONS
// ============================================================

async function sendWeeklyResultsToParents(weekNumber, termId, classId, studentId) {
    const statusEl = document.getElementById('emailStatus');
    if (!statusEl) {
        alert('Email status element not found.');
        return;
    }

    statusEl.textContent = '⏳ Sending emails...';
    statusEl.style.color = '#1a3c5e';

    const EDGE_FUNCTION_URL = 'https://tfradfxljdfcjenpuoxt.supabase.co/functions/v1/send-email';

    let linksQuery = supabaseClient
        .from('parent_children')
        .select('student_id, students(id, full_name, class_id), parent_id');
    if (studentId) linksQuery = linksQuery.eq('student_id', studentId);

    const { data: linksRaw, error } = await linksQuery;

    if (error) {
        statusEl.textContent = '❌ Error: ' + error.message;
        statusEl.style.color = '#b91c1c';
        return;
    }

    // Class filter applied after fetch since it's on the joined student row
    const links = classId
        ? (linksRaw || []).filter(l => l.students?.class_id === parseInt(classId))
        : linksRaw;

    if (!links || links.length === 0) {
        statusEl.textContent = '⚠️ No parent-child links found for that selection. Use "Link Parent to Child" first.';
        statusEl.style.color = '#d79b00';
        return;
    }

    // Look up each parent's email from public.users
    const parentIds = [...new Set(links.map(l => l.parent_id))];
    const { data: parentUsers } = await supabaseClient
        .from('users')
        .select('id, email')
        .in('id', parentIds);

    const parentEmailMap = {};
    (parentUsers || []).forEach(p => { parentEmailMap[p.id] = p.email; });

    let sentCount = 0;
    let errorCount = 0;
    let processed = 0;

    for (const link of links) {
        processed++;
        statusEl.textContent = `⏳ Sending email ${processed} of ${links.length}...`;

        const student = link.students;
        const parentEmail = parentEmailMap[link.parent_id];
        if (!student || !parentEmail) continue;

        const { data: scores } = await supabaseClient
            .from('weekly_test_results')
            .select('score, subjects(name)')
            .eq('student_id', student.id)
            .eq('week_number', weekNumber)
            .eq('term_id', termId);

        if (!scores || scores.length === 0) continue;

        const total = scores.reduce((sum, s) => sum + s.score, 0);
        const average = total / scores.length;

        const subject = `📊 Weekly Test Results - Week ${weekNumber}`;
        const html = `
            <h2>Wonderhills College</h2>
            <h3>Weekly Test Results</h3>
            <p><strong>Student:</strong> ${student.full_name}</p>
            <p><strong>Week:</strong> ${weekNumber}</p>
            <table border="1" cellpadding="8" style="border-collapse:collapse; width:100%;">
                <tr><th style="background:#4a2c1a; color:white;">Subject</th><th style="background:#4a2c1a; color:white;">Score</th></tr>
                ${scores.map(s => `<tr><td>${s.subjects?.name || 'Unknown'}</td><td>${s.score}/100</td></tr>`).join('')}
                <tr><td><strong>Average</strong></td><td><strong>${average.toFixed(1)}%</strong></td></tr>
            </table>
            <p>${average >= 70 ? '✅ Good performance! Keep it up!' : average >= 50 ? '⚠️ Average performance. Encourage your child to do more.' : '❌ Below average. Please contact the school.'}</p>
            <p>© 2026 Wonderhills College</p>
        `;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const response = await fetch(EDGE_FUNCTION_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
                },
                body: JSON.stringify({
                    to: parentEmail,
                    subject: subject,
                    html: html
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (response.ok) sentCount++;
            else errorCount++;
        } catch (e) {
            // Includes a 15-second timeout — a single unresponsive email
            // send can no longer freeze the whole batch indefinitely.
            errorCount++;
        }
    }

    statusEl.textContent = `✅ ${sentCount} emails sent! ❌ ${errorCount} failed.`;
    statusEl.style.color = sentCount > 0 ? '#166534' : '#b91c1c';
}

// ============================================================
// SEND RESULTS DIRECTLY TO STUDENTS (mirrors the parent version,
// but sends straight to the student's own email — no parent link
// required, since not every student necessarily has a linked parent).
// ============================================================
async function sendWeeklyResultsToStudents(weekNumber, termId, classId, studentIds) {
    const statusEl = document.getElementById('studentEmailStatus');
    if (!statusEl) {
        alert('Email status element not found.');
        return;
    }

    statusEl.textContent = '⏳ Sending emails...';
    statusEl.style.color = '#1a3c5e';

    const EDGE_FUNCTION_URL = 'https://tfradfxljdfcjenpuoxt.supabase.co/functions/v1/send-email';

    let studentQuery = supabaseClient
        .from('students')
        .select('id, full_name, email, class_id')
        .not('email', 'is', null);
    if (studentIds && studentIds.length > 0) studentQuery = studentQuery.in('id', studentIds);
    else if (classId) studentQuery = studentQuery.eq('class_id', classId);

    const { data: students, error } = await studentQuery;

    if (error) {
        statusEl.textContent = '❌ Error: ' + error.message;
        statusEl.style.color = '#b91c1c';
        return;
    }

    if (!students || students.length === 0) {
        statusEl.textContent = '⚠️ No students with an email found for that selection.';
        statusEl.style.color = '#d79b00';
        return;
    }

    let sentCount = 0;
    let errorCount = 0;
    let processed = 0;

    for (const student of students) {
        processed++;
        statusEl.textContent = `⏳ Sending email ${processed} of ${students.length}...`;

        const { data: scores } = await supabaseClient
            .from('weekly_test_results')
            .select('score, subjects(name)')
            .eq('student_id', student.id)
            .eq('week_number', weekNumber)
            .eq('term_id', termId);

        if (!scores || scores.length === 0) continue;

        const total = scores.reduce((sum, s) => sum + s.score, 0);
        const average = total / scores.length;

        const subject = `📊 Your Weekly Test Results - Week ${weekNumber}`;
        const html = `
            <h2>Wonderhills College</h2>
            <h3>Weekly Test Results</h3>
            <p><strong>Student:</strong> ${student.full_name}</p>
            <p><strong>Week:</strong> ${weekNumber}</p>
            <table border="1" cellpadding="8" style="border-collapse:collapse; width:100%;">
                <tr><th style="background:#4a2c1a; color:white;">Subject</th><th style="background:#4a2c1a; color:white;">Score</th></tr>
                ${scores.map(s => `<tr><td>${s.subjects?.name || 'Unknown'}</td><td>${s.score}/100</td></tr>`).join('')}
                <tr><td><strong>Average</strong></td><td><strong>${Math.round(average)}%</strong></td></tr>
            </table>
            <p>${average >= 70 ? '✅ Good performance! Keep it up!' : average >= 50 ? '⚠️ Average performance — you can do better.' : '❌ Below average. Please see a teacher for help.'}</p>
            <p>© 2026 Wonderhills College</p>
        `;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const response = await fetch(EDGE_FUNCTION_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
                },
                body: JSON.stringify({ to: student.email, subject: subject, html: html }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (response.ok) sentCount++;
            else errorCount++;
        } catch (e) {
            errorCount++;
        }
    }

    statusEl.textContent = `✅ ${sentCount} emails sent! ❌ ${errorCount} failed.`;
    statusEl.style.color = sentCount > 0 ? '#166534' : '#b91c1c';
}

async function sendCumulativeResultsToStudents(termId, classId, studentIds) {
    const statusEl = document.getElementById('studentEmailStatus');
    if (!statusEl) {
        alert('Email status element not found.');
        return;
    }

    statusEl.textContent = '⏳ Sending emails...';
    statusEl.style.color = '#1a3c5e';

    const EDGE_FUNCTION_URL = 'https://tfradfxljdfcjenpuoxt.supabase.co/functions/v1/send-email';

    const { data: termRow } = await supabaseClient.from('terms').select('name').eq('id', termId).maybeSingle();
    const termName = termRow?.name || `Term ${termId}`;

    let studentQuery = supabaseClient
        .from('students')
        .select('id, full_name, email, class_id')
        .not('email', 'is', null);
    if (studentIds && studentIds.length > 0) studentQuery = studentQuery.in('id', studentIds);
    else if (classId) studentQuery = studentQuery.eq('class_id', classId);

    const { data: students, error } = await studentQuery;

    if (error) {
        statusEl.textContent = '❌ Error: ' + error.message;
        statusEl.style.color = '#b91c1c';
        return;
    }

    if (!students || students.length === 0) {
        statusEl.textContent = '⚠️ No students with an email found for that selection.';
        statusEl.style.color = '#d79b00';
        return;
    }

    let sentCount = 0;
    let errorCount = 0;
    let processed = 0;

    for (const student of students) {
        processed++;
        statusEl.textContent = `⏳ Sending email ${processed} of ${students.length}...`;

        const { data: weeklyScores } = await supabaseClient
            .from('weekly_test_results')
            .select('subject_id, score, subjects(name)')
            .eq('student_id', student.id)
            .eq('term_id', termId);

        if (!weeklyScores || weeklyScores.length === 0) continue;

        const subjectScores = {};
        weeklyScores.forEach(w => {
            const name = w.subjects?.name || 'Unknown';
            if (!subjectScores[name]) subjectScores[name] = [];
            subjectScores[name].push(w.score);
        });

        const subjectCAs = Object.entries(subjectScores).map(([name, scores]) => ({
            name,
            ca: calculateCA(scores)
        }));
        const overallCA = Math.round(subjectCAs.reduce((sum, s) => sum + s.ca, 0) / subjectCAs.length);

        const subject = `📊 Your Cumulative Scores - ${termName}`;
        const html = `
            <h2>Wonderhills College</h2>
            <h3>Cumulative Test Scores</h3>
            <p><strong>Student:</strong> ${student.full_name}</p>
            <p><strong>Term:</strong> ${termName}</p>
            <table border="1" cellpadding="8" style="border-collapse:collapse; width:100%;">
                <tr><th style="background:#4a2c1a; color:white;">Subject</th><th style="background:#4a2c1a; color:white;">CA (out of 25)</th></tr>
                ${subjectCAs.map(s => `<tr><td>${s.name}</td><td>${s.ca}</td></tr>`).join('')}
                <tr><td><strong>Overall CA</strong></td><td><strong>${overallCA}/25</strong></td></tr>
            </table>
            <p>© 2026 Wonderhills College</p>
        `;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const response = await fetch(EDGE_FUNCTION_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
                },
                body: JSON.stringify({ to: student.email, subject: subject, html: html }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (response.ok) sentCount++;
            else errorCount++;
        } catch (e) {
            errorCount++;
        }
    }

    statusEl.textContent = `✅ ${sentCount} emails sent! ❌ ${errorCount} failed.`;
    statusEl.style.color = sentCount > 0 ? '#166534' : '#b91c1c';
}
